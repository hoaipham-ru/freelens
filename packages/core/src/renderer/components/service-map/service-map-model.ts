/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Finds what is wrong in the cluster and groups it into incidents. Pure: no stores, no DI, so
// every rule is unit-tested with fixtures.
//
// 1. Issues: rules over plain manifests (pods, workloads, Services, routes, references, nodes),
//    each issue on one node of the map. Pods fold into their workload, as in Topology.
// 2. Links: what sends traffic to or needs what. Topology's links (routes, exposes, calls from
//    configuration), plus references to Secrets, ConfigMaps and claims, image registries, the
//    node a pod runs on, and Services named in Warning events.
// 3. Incidents: nodes with issues that are linked to each other are one incident. Its suspected
//    root cause is the one at the end of the chain: failing on its own, not because of the next
//    hop. Everything that sends traffic to the incident and is still healthy is at risk.
// Issues that are not urgent (a workload scaled to 0, a Service nothing uses that selects no
// pods) are housekeeping, listed apart.
//
// Kubernetes keeps events for about an hour, so the timeline only goes back as far as they do.

import {
  buildTopology,
  findServiceReferences,
  isApiServer,
  keyOf,
  podTemplateOf,
  resolveServiceHost,
  selectorMatches,
} from "../topology/topology-model";

import type { RawObject, ReferenceFinder, TopologyInput } from "../topology/topology-model";

export type Health = "ok" | "warn" | "err" | "missing" | "idle";
export type Severity = "critical" | "warning" | "info";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";
export type LinkType = "routes" | "exposes" | "calls" | "mentions" | "uses" | "pulls" | "runs-on" | "needs";

export type RuleId =
  | "crashloop"
  | "image-pull"
  | "config-error"
  | "oom"
  | "unschedulable"
  | "stuck-init"
  | "stuck-creating"
  | "not-ready"
  | "restarts"
  | "pod-failed"
  | "evicted"
  | "replica-shortfall"
  | "rollout-stuck"
  | "scaled-to-zero"
  | "job-failed"
  | "cronjob-failing"
  | "old-failed-jobs"
  | "service-no-endpoints"
  | "service-no-pods"
  | "lb-pending"
  | "route-missing-service"
  | "missing-gateway"
  | "ingress-missing-service"
  | "ingress-class-missing"
  | "ingress-tls-missing"
  | "ingress-no-address"
  | "missing-secret"
  | "missing-configmap"
  | "missing-pvc"
  | "missing-pull-secret"
  | "pvc-pending"
  | "node-not-ready"
  | "node-pressure"
  | "node-cordoned"
  | "missing-service-ref"
  | "warning-events";

export interface RawEvent {
  metadata: { name: string; namespace?: string; creationTimestamp?: string };
  involvedObject?: { kind?: string; namespace?: string; name?: string };
  reason?: string;
  message?: string;
  type?: string;
  count?: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  eventTime?: string;
  series?: { count?: number; lastObservedTime?: string };
}

export interface HealthInput extends TopologyInput {
  events: RawEvent[];
  nodes: RawObject[];
  storageClasses: RawObject[];
  ingressClasses: RawObject[];
  /** `namespace/name` of every Secret, or undefined when Secrets can't be listed */
  secretNames?: Set<string>;
  now: number;
}

export interface Issue {
  /** `${rule}:${nodeId}` */
  id: string;
  rule: RuleId;
  nodeId: string;
  severity: Severity;
  /** A few words, e.g. "CrashLoopBackOff" */
  title: string;
  /** One sentence */
  detail: string;
  since?: number;
  /** How many pods or objects it stands for */
  count: number;
  /** What Kubernetes said, from a status or the newest matching event */
  message?: string;
  pod?: string;
  container?: string;
  /** Logs of the previous run say why it stopped */
  previous?: boolean;
}

export interface ContainerInfo {
  name: string;
  kind: "init" | "main";
  state: string;
  health: Health;
  restarts: number;
  lastExit?: string;
  image?: string;
}

export interface PodInfo {
  name: string;
  namespace: string;
  /** The map node of its workload, or of the pod itself */
  ownerId: string;
  node: string;
  health: Health;
  status: string;
  restarts: number;
  containers: ContainerInfo[];
  selfLink: string;
}

export interface MapNode {
  id: string;
  kind: string;
  name: string;
  namespace: string;
  health: Health;
  sub: string;
  badge?: string;
  issues: Issue[];
  pods: PodInfo[];
  selfLink?: string;
  /** Made up to stand for something that isn't an object: a registry, a missing reference */
  synthetic: boolean;
  warningEvents: number;
}

export interface MapLink {
  id: string;
  from: string;
  to: string;
  type: LinkType;
  via: string;
  confidence: Confidence;
}

export interface Fact {
  confidence: Confidence | "";
  text: string;
  count: number;
}

export interface TimelineRow {
  label: string;
  tone: "err" | "warn";
  /** Fractions of the window, 0 to 1 */
  bands: [number, number][];
  ticks: number[];
}

export interface Incident {
  id: string;
  severity: "critical" | "warning";
  title: string;
  meta: string;
  tags: string[];
  since?: number;
  sinceText: string;
  rootId: string;
  /** One failing thing that nothing else is linked to */
  isolated: boolean;
  nodeIds: string[];
  atRiskIds: string[];
  links: MapLink[];
  cause: string;
  risk: string;
  facts: Fact[];
  action: string;
  cmd: string;
  primary: { label: string; nodeId: string; pod?: string; container?: string; previous?: boolean };
  issues: Issue[];
  namespaces: string[];
  timeline: { rows: TimelineRow[]; start: number; end: number };
}

export interface HousekeepingGroup {
  rule: RuleId;
  title: string;
  note: string;
  count: number;
  issues: Issue[];
}

export interface HealthReport {
  nodes: Record<string, MapNode>;
  links: MapLink[];
  incidents: Incident[];
  housekeeping: HousekeepingGroup[];
  issueCount: number;
  events: EventRecord[];
}

export interface EventRecord {
  nodeId: string;
  pod?: string;
  reason: string;
  message: string;
  first: number;
  last: number;
  count: number;
}

// ---------------------------------------------------------------- helpers

const nsOf = (o: { metadata: { namespace?: string } }) => o.metadata.namespace ?? "";
const time = (text?: string) => {
  const value = text ? Date.parse(text) : Number.NaN;

  return Number.isFinite(value) ? value : undefined;
};
const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
const minOf = (...values: (number | undefined)[]) => {
  const defined = values.filter((v): v is number => v !== undefined);

  return defined.length ? Math.min(...defined) : undefined;
};
const sample = (names: string[], max = 3) =>
  names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} +${names.length - max}`;
const SEVERITY_RANK: Record<Severity, number> = { critical: 2, warning: 1, info: 0 };
const worse = (a: Severity, b: Severity) => (SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b);
const WORKLOAD_KINDS = ["Deployment", "StatefulSet", "DaemonSet", "CronJob", "Job"];
const isWorkload = (kind: string) => WORKLOAD_KINDS.includes(kind) || kind === "Pod";

/** "13m", "39h", "17d" */
export function ago(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.round(minutes / 60);

  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

const PUBLIC_REGISTRIES = new Set([
  "docker.io",
  "index.docker.io",
  "registry-1.docker.io",
  "ghcr.io",
  "quay.io",
  "registry.k8s.io",
  "k8s.gcr.io",
  "gcr.io",
  "public.ecr.aws",
  "mcr.microsoft.com",
  "docker.elastic.co",
  "registry.gitlab.com",
]);

/** The registry an image is pulled from: its first part when that is a host, else Docker Hub. */
export function registryOf(image: string): string {
  const first = image.split("/")[0];

  return image.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost")
    ? first
    : "docker.io";
}

// ---------------------------------------------------------------- pods

interface Finding {
  rule: RuleId;
  severity: Severity;
  title: string;
  detail: string;
  since?: number;
  message?: string;
  container?: string;
  image?: string;
  previous?: boolean;
}

interface ContainerStatus {
  name: string;
  image?: string;
  ready?: boolean;
  restartCount?: number;
  state?: {
    waiting?: { reason?: string; message?: string };
    running?: { startedAt?: string };
    terminated?: { reason?: string; exitCode?: number; finishedAt?: string };
  };
  lastState?: { terminated?: { reason?: string; exitCode?: number; finishedAt?: string } };
}

const CRASH = /CrashLoopBackOff/;
const IMAGE = /ImagePullBackOff|ErrImagePull|InvalidImageName|ErrImageNeverPull/;
const CONFIG = /CreateContainerConfigError|CreateContainerError|RunContainerError/;

/** What a pod's status says about it: a summary for the map, and what is wrong with it. */
export function analysePod(pod: RawObject, ownerId: string, now: number): { info: PodInfo; findings: Finding[] } {
  const namespace = nsOf(pod);
  const name = pod.metadata.name;
  const phase: string = pod.status?.phase ?? "Unknown";
  const conditions: { type: string; status: string; reason?: string; message?: string; lastTransitionTime?: string }[] =
    pod.status?.conditions ?? [];
  const condition = (type: string) => conditions.find((c) => c.type === type);
  const specImages = new Map<string, string>(
    [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])].map(
      (c: { name: string; image: string }) => [c.name, c.image] as [string, string],
    ),
  );
  const init: ContainerStatus[] = pod.status?.initContainerStatuses ?? [];
  const main: ContainerStatus[] = pod.status?.containerStatuses ?? [];
  const containers: ContainerInfo[] = [];
  const findings: Finding[] = [];
  const created = time(pod.metadata.creationTimestamp);
  const readySince = time(condition("Ready")?.lastTransitionTime);
  const add = (finding: Finding) => {
    if (!findings.some((f) => f.rule === finding.rule)) {
      findings.push(finding);
    }
  };

  for (const [kind, statuses] of [
    ["init", init],
    ["main", main],
  ] as const) {
    for (const s of statuses) {
      const waiting = s.state?.waiting;
      const running = s.state?.running;
      const terminated = s.state?.terminated;
      const last = s.lastState?.terminated;
      const restarts = s.restartCount ?? 0;
      const image = s.image ?? specImages.get(s.name);
      let health: Health = "ok";
      let state = "Unknown";

      if (waiting) {
        state = waiting.reason ?? "Waiting";
        health = /BackOff|Err|Invalid|Error/.test(state) ? "err" : "warn";
      } else if (running) {
        state = kind === "main" && !s.ready ? "Running · not ready" : "Running";
        health = kind === "main" && !s.ready ? "warn" : "ok";
      } else if (terminated) {
        state = `${terminated.reason ?? "Terminated"} · exit ${terminated.exitCode ?? "?"}`;
        health = terminated.exitCode === 0 ? (kind === "init" ? "ok" : "idle") : "err";
      }

      containers.push({
        name: s.name,
        kind,
        state,
        health,
        restarts,
        image,
        lastExit: last ? `${last.reason ?? "Error"} · exit ${last.exitCode ?? "?"}` : undefined,
      });

      const exitText = last ? `: ${last.reason ?? "error"}, exit code ${last.exitCode ?? "?"}` : "";
      const reason = waiting?.reason ?? "";

      if (CRASH.test(reason)) {
        add({
          rule: "crashloop",
          severity: "critical",
          title: kind === "init" ? "Init:CrashLoopBackOff" : "CrashLoopBackOff",
          detail: `Container ${s.name} keeps exiting${exitText} (${plural(restarts, "restart")}).`,
          since: minOf(readySince, created),
          message: waiting?.message,
          container: s.name,
          previous: true,
        });
      } else if (IMAGE.test(reason)) {
        add({
          rule: "image-pull",
          severity: "critical",
          title: reason,
          detail: `The image ${image ?? "?"} of container ${s.name} can't be pulled.`,
          since: minOf(readySince, created),
          message: waiting?.message,
          container: s.name,
          image,
        });
      } else if (CONFIG.test(reason)) {
        add({
          rule: "config-error",
          severity: "critical",
          title: reason,
          detail: `Container ${s.name} can't be created${waiting?.message ? `: ${waiting.message}` : "."}`,
          since: minOf(readySince, created),
          message: waiting?.message,
          container: s.name,
        });
      }

      if (last?.reason === "OOMKilled" && restarts > 0) {
        const killedAt = time(last.finishedAt);
        // Long ago, and running since: worth knowing, not urgent.
        const recent = killedAt === undefined || now - killedAt < 24 * 60 * 60_000;

        add({
          rule: "oom",
          severity: recent ? "warning" : "info",
          title: "OOMKilled",
          detail: `Container ${s.name} was killed for using more memory than its limit (${plural(restarts, "restart")}).`,
          since: time(last.finishedAt),
          container: s.name,
          previous: true,
        });
      }
    }
  }

  const scheduled = condition("PodScheduled");
  const initialized = condition("Initialized");
  const ready = condition("Ready");
  const age = created !== undefined ? now - created : 0;

  if (phase === "Pending" && scheduled?.status === "False") {
    add({
      rule: "unschedulable",
      severity: "critical",
      title: scheduled.reason ?? "Unschedulable",
      detail: `The scheduler can't place it${scheduled.message ? `: ${scheduled.message}` : "."}`,
      since: time(scheduled.lastTransitionTime) ?? created,
      message: scheduled.message,
    });
  }

  const busy = findings.some((f) => f.severity === "critical");
  const unfinishedInit = init.find((s) => !(s.state?.terminated?.exitCode === 0));

  if (!busy && initialized?.status === "False" && unfinishedInit && age > 5 * 60_000 && phase !== "Failed") {
    add({
      rule: "stuck-init",
      severity: "warning",
      title: `Init:${init.filter((s) => s.state?.terminated?.exitCode === 0).length}/${init.length}`,
      detail: `Init container ${unfinishedInit.name} hasn't finished after ${ago(age)}.`,
      since: time(initialized.lastTransitionTime) ?? created,
      container: unfinishedInit.name,
    });
  }

  const creating = main.find((s) => s.state?.waiting?.reason === "ContainerCreating");

  if (!busy && creating && initialized?.status !== "False" && age > 5 * 60_000) {
    add({
      rule: "stuck-creating",
      severity: "warning",
      title: "ContainerCreating",
      detail: `Container ${creating.name} hasn't started after ${ago(age)}, often because a volume can't be mounted.`,
      since: created,
    });
  }

  if (
    !busy &&
    phase === "Running" &&
    initialized?.status !== "False" &&
    ready?.status === "False" &&
    readySince !== undefined &&
    now - readySince > 2 * 60_000 &&
    !creating
  ) {
    const notReady = main.filter((s) => !s.ready).map((s) => s.name);

    add({
      rule: "not-ready",
      severity: "warning",
      title: "Not ready",
      detail: `It runs, but ${notReady.length ? `container ${notReady.join(", ")}` : "it"} fails its readiness probe, so it gets no traffic.`,
      since: readySince,
      container: notReady[0],
    });
  }

  const maxRestarts = Math.max(0, ...main.map((s) => s.restartCount ?? 0));
  const lastFinish = Math.max(0, ...main.map((s) => time(s.lastState?.terminated?.finishedAt) ?? 0));

  if (!busy && ready?.status === "True" && maxRestarts >= 5 && now - lastFinish < 60 * 60_000) {
    const restarted = main.find((s) => (s.restartCount ?? 0) === maxRestarts);

    add({
      rule: "restarts",
      severity: "warning",
      title: `${maxRestarts} restarts`,
      detail: `Container ${restarted?.name} restarted ${maxRestarts} times, the last time ${ago(now - lastFinish)} ago.`,
      since: lastFinish,
      container: restarted?.name,
      previous: true,
    });
  }

  if (phase === "Failed") {
    const evicted = pod.status?.reason === "Evicted";

    add({
      rule: evicted ? "evicted" : "pod-failed",
      severity: evicted ? "info" : "warning",
      title: pod.status?.reason ?? "Failed",
      detail: pod.status?.message ?? "The pod stopped with an error and won't be restarted.",
      since: created,
    });
  }

  const worst = findings.reduce<Severity | undefined>(
    (acc, f) => (f.severity === "info" ? acc : acc ? worse(acc, f.severity) : f.severity),
    undefined,
  );
  const readyCount = main.filter((s) => s.ready).length;
  const waitingReason = [...init, ...main]
    .map((s) => s.state?.waiting?.reason)
    .find((r) => r && r !== "PodInitializing");
  let status: string;

  if (phase === "Failed" || phase === "Succeeded") {
    status = pod.status?.reason ?? phase;
  } else if (initialized?.status === "False" && init.length > 0) {
    const done = init.filter((s) => s.state?.terminated?.exitCode === 0).length;
    const initWaiting = init.map((s) => s.state?.waiting?.reason).find((r) => r && r !== "PodInitializing");

    status = initWaiting ? `Init:${initWaiting}` : `Init:${done}/${init.length}`;
  } else if (waitingReason) {
    status = waitingReason;
  } else if (phase === "Running") {
    status = readyCount === main.length ? "Running" : `Running · ${readyCount}/${main.length} ready`;
  } else {
    status = phase;
  }

  return {
    info: {
      name,
      namespace,
      ownerId,
      node: pod.spec?.nodeName ?? "",
      health:
        worst === "critical"
          ? "err"
          : worst === "warning"
            ? "warn"
            : phase === "Succeeded"
              ? "idle"
              : phase === "Running" && readyCount === main.length
                ? "ok"
                : phase === "Pending"
                  ? "warn"
                  : "ok",
      status,
      restarts: maxRestarts,
      containers,
      selfLink: `/api/v1/namespaces/${namespace}/pods/${name}`,
    },
    findings,
  };
}

// ---------------------------------------------------------------- the report

export interface ReportOptions {
  findReferences?: ReferenceFinder;
  /** Incidents muted by the user, by id */
  muted?: Set<string>;
}

export function buildHealthReport(
  input: HealthInput,
  { findReferences = findServiceReferences }: ReportOptions = {},
): HealthReport {
  const { now } = input;
  const topology = buildTopology(input, "architecture", { findReferences });
  const nodes: Record<string, MapNode> = {};
  const links = new Map<string, MapLink>();
  const issues: Issue[] = [];

  for (const n of topology.nodes) {
    nodes[n.id] = {
      id: n.id,
      kind: n.kind,
      name: n.name,
      namespace: n.namespace,
      health: n.outsideView ? "missing" : "ok",
      sub: n.outsideView ? "not found" : n.summary,
      issues: [],
      pods: [],
      selfLink: n.selfLink,
      synthetic: n.outsideView,
      warningEvents: 0,
    };
  }

  const link = (from: string, to: string, type: LinkType, via: string, confidence: Confidence) => {
    if (from === to || !nodes[from] || !nodes[to]) {
      return;
    }

    const id = `${type}:${from}->${to}`;

    if (!links.has(id)) {
      links.set(id, { id, from, to, type, via, confidence });
    }
  };

  for (const edge of topology.edges) {
    link(
      edge.from,
      edge.to,
      edge.type,
      edge.type === "exposes" ? `selector${edge.label.replace(/^exposes/, "")}` : edge.via,
      edge.inferred ? "MEDIUM" : "HIGH",
    );
  }

  const synthetic = (id: string, kind: string, name: string, namespace: string, health: Health, sub: string) => {
    nodes[id] ??= { id, kind, name, namespace, health, sub, issues: [], pods: [], synthetic: true, warningEvents: 0 };

    return nodes[id];
  };
  const missing = (kind: string, namespace: string, name: string) =>
    synthetic(keyOf(kind, namespace, name), kind, name, namespace, "missing", "does not exist").id;
  const issue = (nodeId: string, finding: Omit<Issue, "id" | "nodeId" | "count"> & { count?: number }) => {
    const node = nodes[nodeId];

    if (!node) {
      return undefined;
    }

    const existing = node.issues.find((i) => i.rule === finding.rule);

    if (existing) {
      existing.count += finding.count ?? 1;
      existing.severity = worse(existing.severity, finding.severity);
      existing.since = minOf(existing.since, finding.since);

      return existing;
    }

    const made: Issue = { ...finding, id: `${finding.rule}:${nodeId}`, nodeId, count: finding.count ?? 1 };

    node.issues.push(made);
    issues.push(made);

    return made;
  };

  // ---- owners: pods fold into the workload Topology draws for them
  const withKind = (list: RawObject[], kind: string) => list.map((o) => (o.kind ? o : { ...o, kind }));
  const owners = [
    ...withKind(input.deployments, "Deployment"),
    ...withKind(input.statefulSets, "StatefulSet"),
    ...withKind(input.daemonSets, "DaemonSet"),
    ...withKind(input.replicaSets, "ReplicaSet"),
    ...withKind(input.cronJobs, "CronJob"),
    ...withKind(input.jobs, "Job"),
  ];
  const byUid = new Map<string, RawObject>();
  const byName = new Map<string, RawObject>();

  for (const o of owners) {
    if (o.metadata.uid) byUid.set(o.metadata.uid, o);
    byName.set(`${o.kind}/${nsOf(o)}/${o.metadata.name}`, o);
  }

  const ownerOf = (o: RawObject): RawObject | undefined => {
    for (const ref of o.metadata.ownerReferences ?? []) {
      const owner = (ref.uid && byUid.get(ref.uid)) || byName.get(`${ref.kind}/${nsOf(o)}/${ref.name}`);

      if (owner) return owner;
    }

    return undefined;
  };
  const workloadOf = (o: RawObject): RawObject | undefined => {
    let current: RawObject | undefined = o;

    for (let depth = 0; depth < 4 && current; depth++) {
      const owner = ownerOf(current);

      if (!owner) return undefined;
      if (owner.kind === "Job") return ownerOf(owner)?.kind === "CronJob" ? ownerOf(owner) : owner;
      if (WORKLOAD_KINDS.includes(owner.kind ?? "")) return owner;

      current = owner;
    }

    return undefined;
  };
  const idOfWorkload = (o: RawObject) => keyOf(o.kind ?? "", nsOf(o), o.metadata.name);
  const podOwner = new Map<string, string>();
  const findingsOf = new Map<string, { pod: PodInfo; finding: Finding }[]>();
  const pods = withKind(input.pods, "Pod");

  for (const pod of pods) {
    const workload = workloadOf(pod);
    const ownerId = workload ? idOfWorkload(workload) : keyOf("Pod", nsOf(pod), pod.metadata.name);
    const node = nodes[ownerId];

    podOwner.set(`${nsOf(pod)}/${pod.metadata.name}`, ownerId);

    if (!node || pod.status?.phase === "Succeeded") {
      continue;
    }

    const { info, findings } = analysePod(pod, ownerId, now);
    const batch = workload?.kind === "Job" || workload?.kind === "CronJob";

    node.pods.push(info);

    for (const finding of findings) {
      // A failed run of a Job is the Job's failure, told by its own rule.
      if (batch && (finding.rule === "pod-failed" || finding.rule === "evicted")) {
        continue;
      }

      findingsOf.set(ownerId, [...(findingsOf.get(ownerId) ?? []), { pod: info, finding }]);
    }
  }

  for (const node of Object.values(nodes)) {
    node.pods.sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---- workloads
  const workloads = [
    ...withKind(input.deployments, "Deployment"),
    ...withKind(input.statefulSets, "StatefulSet"),
    ...withKind(input.daemonSets, "DaemonSet"),
  ];
  const readiness = new Map<string, { ready: number; desired: number }>();

  for (const workload of workloads) {
    const id = idOfWorkload(workload);
    const node = nodes[id];

    if (!node) continue;

    const desired: number =
      workload.kind === "DaemonSet" ? (workload.status?.desiredNumberScheduled ?? 0) : (workload.spec?.replicas ?? 1);
    const ready: number =
      workload.kind === "DaemonSet" ? (workload.status?.numberReady ?? 0) : (workload.status?.readyReplicas ?? 0);

    readiness.set(id, { ready, desired });
    node.sub = desired === 0 ? `${workload.kind} · scaled to 0` : `${workload.kind} · ${ready}/${desired} ready`;

    if (desired === 0) {
      issue(id, {
        rule: "scaled-to-zero",
        severity: "info",
        title: "Scaled to 0",
        detail: `${workload.kind} ${node.name} runs no pods.`,
      });
      continue;
    }

    const stuck = (workload.status?.conditions ?? []).find(
      (c: { type: string; status: string; reason?: string }) =>
        c.type === "Progressing" && c.status === "False" && c.reason === "ProgressDeadlineExceeded",
    );

    if (stuck) {
      issue(id, {
        rule: "rollout-stuck",
        severity: "warning",
        title: "Rollout stuck",
        detail: `The newest rollout made no progress in time${stuck.message ? `: ${stuck.message}` : "."}`,
        since: time(stuck.lastTransitionTime),
        message: stuck.message,
      });
    }
  }

  // Findings of pods, one issue per rule and workload.
  for (const [ownerId, list] of findingsOf) {
    const node = nodes[ownerId];
    const total = node.pods.length;
    const { ready = 0, desired = total } = readiness.get(ownerId) ?? {};
    const rules = [...new Set(list.map((f) => f.finding.rule))];

    for (const rule of rules) {
      const matching = list.filter((f) => f.finding.rule === rule);
      const first = matching[0];
      let severity = matching.reduce<Severity>((acc, f) => worse(acc, f.finding.severity), "info");

      if (rule === "not-ready" || rule === "stuck-init" || rule === "stuck-creating") {
        severity = ready === 0 && desired > 0 ? "critical" : "warning";
      }

      issue(ownerId, {
        rule,
        severity,
        title: first.finding.title,
        detail:
          matching.length > 1 || total > 1
            ? `${first.finding.detail} ${matching.length} of ${plural(total, "pod")}.`
            : first.finding.detail,
        since: minOf(...matching.map((f) => f.finding.since)),
        count: matching.length,
        message: first.finding.message,
        pod: first.pod.name,
        container: first.finding.container,
        previous: first.finding.previous,
      });
    }
  }

  // Fewer pods than wanted, without a pod that says why.
  for (const [id, { ready, desired }] of readiness) {
    const node = nodes[id];

    if (desired > 0 && ready < desired && !node.issues.some((i) => i.severity !== "info")) {
      issue(id, {
        rule: "replica-shortfall",
        severity: ready === 0 ? "critical" : "warning",
        title: `${ready}/${desired} ready`,
        detail:
          node.pods.length < desired
            ? `It should run ${plural(desired, "pod")}, but only ${node.pods.length} exist.`
            : `${desired - ready} of its ${plural(desired, "pod")} are not ready.`,
      });
    }
  }

  // ---- Jobs and CronJobs
  const jobs = withKind(input.jobs, "Job");
  const jobFailure = (job: RawObject) =>
    (job.status?.conditions ?? []).find(
      (c: { type: string; status: string }) => c.type === "Failed" && c.status === "True",
    ) as { reason?: string; message?: string; lastTransitionTime?: string } | undefined;
  const jobDone = (job: RawObject) =>
    (job.status?.conditions ?? []).some(
      (c: { type: string; status: string }) => (c.type === "Complete" || c.type === "Failed") && c.status === "True",
    );
  const startOf = (job: RawObject) => time(job.status?.startTime) ?? time(job.metadata.creationTimestamp) ?? 0;

  for (const job of jobs) {
    const parent = ownerOf(job);

    if (parent?.kind === "CronJob") continue;

    const failure = jobFailure(job);
    const id = idOfWorkload(job);

    if (failure && nodes[id]) {
      nodes[id].sub = `Job · ${failure.reason ?? "failed"}`;
      issue(id, {
        rule: "job-failed",
        severity: "critical",
        title: failure.reason ?? "Failed",
        detail: `The Job failed${failure.message ? `: ${failure.message}` : "."}`,
        since: time(failure.lastTransitionTime),
        message: failure.message,
      });
    }
  }

  for (const cronJob of withKind(input.cronJobs, "CronJob")) {
    const id = idOfWorkload(cronJob);
    const node = nodes[id];

    if (!node) continue;

    if (cronJob.spec?.suspend) {
      node.health = "idle";
      node.sub = "CronJob · suspended";
      continue;
    }

    const runs = jobs
      .filter((job) => {
        const owner = ownerOf(job);

        return (
          owner?.kind === "CronJob" && owner.metadata.name === cronJob.metadata.name && nsOf(owner) === nsOf(cronJob)
        );
      })
      .sort((a, b) => startOf(b) - startOf(a));
    const finished = runs.filter(jobDone);
    const failed = finished.filter((job) => jobFailure(job));
    const newest = finished[0];

    node.sub = `CronJob · ${cronJob.spec?.schedule ?? ""}`.trim();

    if (newest && jobFailure(newest)) {
      // The failures in a row, newest first.
      const streak = finished.findIndex((job) => !jobFailure(job));
      const inRow = streak === -1 ? finished.length : streak;
      const failure = jobFailure(newest);

      node.badge = `${inRow} failed`;
      issue(id, {
        rule: "cronjob-failing",
        severity: "critical",
        title: failure?.reason ?? "Failed",
        detail: `Its last ${plural(inRow, "run")} failed${failure?.reason ? ` (${failure.reason})` : ""}; the newest is ${newest.metadata.name}.`,
        since: startOf(finished[inRow - 1] ?? newest),
        count: inRow,
        message: failure?.message,
        pod: newest.metadata.name,
      });
    } else if (failed.length > 0) {
      issue(id, {
        rule: "old-failed-jobs",
        severity: "info",
        title: `${failed.length} old failed`,
        detail: `${plural(failed.length, "older run")} failed; the newest one succeeded.`,
        count: failed.length,
      });
    }
  }

  // ---- Services
  const services = withKind(input.services, "Service");
  const podsByNamespace = new Map<string, RawObject[]>();

  for (const pod of pods) {
    if (pod.status?.phase === "Succeeded" || pod.status?.phase === "Failed") continue;
    podsByNamespace.set(nsOf(pod), [...(podsByNamespace.get(nsOf(pod)) ?? []), pod]);
  }

  const podReady = (pod: RawObject) =>
    (pod.status?.conditions ?? []).some(
      (c: { type: string; status: string }) => c.type === "Ready" && c.status === "True",
    );
  const incoming = (id: string) => [...links.values()].filter((l) => l.to === id && l.type !== "exposes");
  const lbProvider = "lbprovider//";

  for (const service of services) {
    const id = keyOf("Service", nsOf(service), service.metadata.name);
    const node = nodes[id];
    const selector: Record<string, string> = service.spec?.selector ?? {};

    if (!node) continue;

    if (service.spec?.type === "LoadBalancer") {
      const addresses = [...(service.status?.loadBalancer?.ingress ?? []), ...(service.spec?.externalIPs ?? [])];

      if (addresses.length === 0) {
        synthetic(lbProvider, "Controller", "LoadBalancer provider", "", "missing", "none gave an address");
        link(id, lbProvider, "needs", "type LoadBalancer", "HIGH");
        issue(id, {
          rule: "lb-pending",
          severity: "warning",
          title: "LoadBalancer pending",
          detail: "It is of type LoadBalancer, but no controller has given it an address.",
          since: time(service.metadata.creationTimestamp),
        });
      }
    }

    if (Object.keys(selector).length === 0) continue;

    const selected = (podsByNamespace.get(nsOf(service)) ?? []).filter((pod) =>
      selectorMatches(selector, pod.metadata.labels),
    );
    const ready = selected.filter(podReady).length;

    // The workloads of the pods it selects, also when the selector names a label that only the
    // pods carry (vault-active, statefulset.kubernetes.io/pod-name), not their template.
    for (const pod of selected) {
      const owner = podOwner.get(`${nsOf(pod)}/${pod.metadata.name}`);

      if (owner) {
        link(id, owner, "exposes", "selector", "HIGH");
      }
    }

    const behind = [...links.values()].filter((l) => l.from === id && l.type === "exposes").map((l) => nodes[l.to]);

    if (selected.length > 0) {
      node.sub = `${ready}/${selected.length} endpoints ready`;
    }

    if (selected.length > 0 && ready === 0) {
      issue(id, {
        rule: "service-no-endpoints",
        severity: "critical",
        title: "0 endpoints ready",
        detail: `None of the ${plural(selected.length, "pod")} it selects is ready, so it has nowhere to send traffic.`,
      });
    } else if (selected.length === 0) {
      const scaledDown = behind.some((n) => n?.issues.some((i) => i.rule === "scaled-to-zero"));

      node.sub = "selects no pods";

      if (behind.length > 0 && !scaledDown) {
        issue(id, {
          rule: "service-no-endpoints",
          severity: "critical",
          title: "no endpoints",
          detail: `The workload it selects runs no pods, so it has nowhere to send traffic.`,
        });
      } else if (!scaledDown) {
        const users = incoming(id);

        issue(id, {
          rule: "service-no-pods",
          severity: users.length > 0 ? "warning" : "info",
          title: "selects no pods",
          detail: `Its selector ${Object.entries(selector)
            .map(([k, v]) => `${k}=${v}`)
            .join(
              ",",
            )} matches no pod${users.length > 0 ? `, but ${plural(users.length, "thing")} send traffic to it` : ""}.`,
        });
      }
    }
  }

  // ---- routes that point at nothing
  const knownServices = new Set(services.map((s) => `${nsOf(s)}/${s.metadata.name}`));

  for (const virtualService of withKind(input.virtualServices ?? [], "VirtualService")) {
    const namespace = nsOf(virtualService);
    const id = keyOf("VirtualService", namespace, virtualService.metadata.name);

    for (const ref of (virtualService.spec?.gateways ?? []) as string[]) {
      if (ref === "mesh") continue;

      const [gatewayNamespace, gatewayName] = ref.includes("/") ? ref.split("/") : [namespace, ref];
      const gatewayId = keyOf("Gateway", gatewayNamespace, gatewayName);

      if (!nodes[gatewayId] || nodes[gatewayId].synthetic) {
        link(id, missing("Gateway", gatewayNamespace, gatewayName), "routes", "spec.gateways", "HIGH");
        issue(id, {
          rule: "missing-gateway",
          severity: "warning",
          title: "gateway missing",
          detail: `It names Gateway ${gatewayNamespace}/${gatewayName}, which doesn't exist, so no traffic comes in through it.`,
          since: time(virtualService.metadata.creationTimestamp),
        });
      }
    }

    const hosts: string[] = [
      ...(virtualService.spec?.http ?? []),
      ...(virtualService.spec?.tcp ?? []),
      ...(virtualService.spec?.tls ?? []),
    ]
      .flatMap((route: { route?: { destination?: { host?: string } }[] }) => route.route ?? [])
      .map((route) => route.destination?.host)
      .filter((host): host is string => Boolean(host));

    for (const host of hosts) {
      const target = resolveServiceHost(host, namespace, knownServices);

      if (target && !knownServices.has(`${target.namespace}/${target.service}`)) {
        link(id, missing("Service", target.namespace, target.service), "routes", `destination ${host}`, "HIGH");
        issue(id, {
          rule: "route-missing-service",
          severity: "warning",
          title: "no such Service",
          detail: `It routes to ${host}, which matches no Service.`,
          since: time(virtualService.metadata.creationTimestamp),
        });
      }
    }
  }

  for (const instance of input.apisix ?? []) {
    for (const route of instance.routes) {
      const id = keyOf("apisixroute", instance.namespace, route.id);

      for (const upstream of route.upstreams) {
        const target = resolveServiceHost(upstream.host, instance.namespace, knownServices);

        if (target && !knownServices.has(`${target.namespace}/${target.service}`)) {
          link(id, missing("Service", target.namespace, target.service), "routes", `upstream ${upstream.host}`, "HIGH");
          issue(id, {
            rule: "route-missing-service",
            severity: "warning",
            title: "no such Service",
            detail: `Its upstream ${upstream.host} matches no Service.`,
          });
        }
      }
    }
  }

  const ingressClasses = new Set(input.ingressClasses.map((c) => c.metadata.name));
  const secrets = input.secretNames;
  const hasSecret = (namespace: string, name: string) => !secrets || secrets.has(`${namespace}/${name}`);

  for (const ingress of withKind(input.ingresses, "Ingress")) {
    const namespace = nsOf(ingress);
    const id = keyOf("Ingress", namespace, ingress.metadata.name);
    const since = time(ingress.metadata.creationTimestamp);
    const className: string | undefined =
      ingress.spec?.ingressClassName ?? ingress.metadata.annotations?.["kubernetes.io/ingress.class"];
    let found = false;

    if (className && input.ingressClasses.length > 0 && !ingressClasses.has(className)) {
      link(id, missing("IngressClass", "", className), "needs", "ingressClassName", "HIGH");
      found = true;
      issue(id, {
        rule: "ingress-class-missing",
        severity: "warning",
        title: "class missing",
        detail: `It asks for IngressClass ${className}, which isn't installed, so no controller serves it.`,
        since,
      });
    }

    for (const tls of (ingress.spec?.tls ?? []) as { secretName?: string }[]) {
      if (tls.secretName && !hasSecret(namespace, tls.secretName)) {
        link(id, missing("Secret", namespace, tls.secretName), "uses", "spec.tls", "HIGH");
        found = true;
        issue(id, {
          rule: "ingress-tls-missing",
          severity: "warning",
          title: "TLS secret missing",
          detail: `Its TLS secret ${tls.secretName} doesn't exist.`,
          since,
        });
      }
    }

    const backends: { service?: { name?: string }; serviceName?: string }[] = [
      ingress.spec?.defaultBackend ?? ingress.spec?.backend,
      ...(ingress.spec?.rules ?? []).flatMap((r: { http?: { paths?: { backend?: object }[] } }) =>
        (r.http?.paths ?? []).map((p) => p.backend),
      ),
    ].filter(Boolean);

    for (const backend of backends) {
      const name = backend.service?.name ?? backend.serviceName;

      if (name && !knownServices.has(`${namespace}/${name}`)) {
        link(id, missing("Service", namespace, name), "routes", "backend", "HIGH");
        found = true;
        issue(id, {
          rule: "ingress-missing-service",
          severity: "warning",
          title: "no such Service",
          detail: `It sends traffic to Service ${name}, which doesn't exist.`,
          since,
        });
      }
    }

    if (!found && (ingress.status?.loadBalancer?.ingress ?? []).length === 0) {
      issue(id, {
        rule: "ingress-no-address",
        severity: "info",
        title: "no address",
        detail: "No ingress controller has given it an address.",
        since,
      });
    }
  }

  // ---- references to Secrets, ConfigMaps and claims, pull secrets, registries
  const configMapNames = new Set(input.configMaps.map((c) => `${nsOf(c)}/${c.metadata.name}`));
  const claims = new Map(input.persistentVolumeClaims.map((c) => [`${nsOf(c)}/${c.metadata.name}`, c]));
  const storageClasses = new Set(input.storageClasses.map((c) => c.metadata.name));
  const failingPods = (id: string) => nodes[id]?.issues.some((i) => i.severity === "critical") ?? false;
  const referrers: RawObject[] = [
    ...workloads,
    ...withKind(input.cronJobs, "CronJob"),
    ...jobs.filter((job) => ownerOf(job)?.kind !== "CronJob"),
    ...pods.filter((pod) => !workloadOf(pod) && pod.status?.phase !== "Succeeded"),
  ];

  for (const o of referrers) {
    const namespace = nsOf(o);
    const id = idOfWorkload(o);

    if (!nodes[id]) continue;

    const spec = podTemplateOf(o).spec ?? {};
    const containers = [...(spec.initContainers ?? []), ...(spec.containers ?? [])];
    const secretRefs: { name: string; via: string }[] = [];
    const configMapRefs: { name: string; via: string }[] = [];

    for (const volume of spec.volumes ?? []) {
      if (volume.secret?.secretName && !volume.secret.optional)
        secretRefs.push({ name: volume.secret.secretName, via: `volume ${volume.name}` });
      if (volume.configMap?.name && !volume.configMap.optional)
        configMapRefs.push({ name: volume.configMap.name, via: `volume ${volume.name}` });

      for (const source of volume.projected?.sources ?? []) {
        if (source.secret?.name && !source.secret.optional)
          secretRefs.push({ name: source.secret.name, via: `volume ${volume.name}` });
        if (source.configMap?.name && !source.configMap.optional)
          configMapRefs.push({ name: source.configMap.name, via: `volume ${volume.name}` });
      }

      const claim = volume.persistentVolumeClaim?.claimName;

      if (claim) {
        const pvc = claims.get(`${namespace}/${claim}`);

        if (!pvc) {
          link(id, missing("PersistentVolumeClaim", namespace, claim), "uses", `volume ${volume.name}`, "HIGH");
          issue(id, {
            rule: "missing-pvc",
            severity: failingPods(id) ? "critical" : "warning",
            title: "claim missing",
            detail: `It mounts the claim ${claim}, which doesn't exist.`,
          });
        } else if (pvc.status?.phase === "Pending") {
          const pvcId = keyOf("PersistentVolumeClaim", namespace, claim);
          const node = synthetic(pvcId, "PersistentVolumeClaim", claim, namespace, "err", "Pending");

          node.synthetic = false;
          node.selfLink = pvc.metadata.selfLink;
          link(id, pvcId, "uses", `volume ${volume.name}`, "HIGH");
          addPendingClaim(pvc, pvcId);
        }
      }
    }

    for (const container of containers) {
      for (const envFrom of container.envFrom ?? []) {
        if (envFrom.secretRef?.name && !envFrom.secretRef.optional)
          secretRefs.push({ name: envFrom.secretRef.name, via: `envFrom of ${container.name}` });
        if (envFrom.configMapRef?.name && !envFrom.configMapRef.optional)
          configMapRefs.push({ name: envFrom.configMapRef.name, via: `envFrom of ${container.name}` });
      }

      for (const env of container.env ?? []) {
        const secretRef = env.valueFrom?.secretKeyRef;
        const configMapRef = env.valueFrom?.configMapKeyRef;

        if (secretRef?.name && !secretRef.optional) secretRefs.push({ name: secretRef.name, via: `env ${env.name}` });
        if (configMapRef?.name && !configMapRef.optional)
          configMapRefs.push({ name: configMapRef.name, via: `env ${env.name}` });
      }
    }

    for (const ref of secretRefs) {
      if (!hasSecret(namespace, ref.name)) {
        link(id, missing("Secret", namespace, ref.name), "uses", ref.via, "HIGH");
        issue(id, {
          rule: "missing-secret",
          severity: failingPods(id) ? "critical" : "warning",
          title: "secret missing",
          detail: `It reads Secret ${ref.name} (${ref.via}), which doesn't exist.`,
        });
      }
    }

    if (input.configMaps.length > 0) {
      for (const ref of configMapRefs) {
        if (!configMapNames.has(`${namespace}/${ref.name}`)) {
          link(id, missing("ConfigMap", namespace, ref.name), "uses", ref.via, "HIGH");
          issue(id, {
            rule: "missing-configmap",
            severity: failingPods(id) ? "critical" : "warning",
            title: "ConfigMap missing",
            detail: `It reads ConfigMap ${ref.name} (${ref.via}), which doesn't exist.`,
          });
        }
      }
    }

    const pulling = nodes[id].issues.find((i) => i.rule === "image-pull");

    for (const pullSecret of (spec.imagePullSecrets ?? []) as { name?: string }[]) {
      if (pullSecret.name && !hasSecret(namespace, pullSecret.name)) {
        if (pulling) {
          link(id, missing("Secret", namespace, pullSecret.name), "uses", "imagePullSecrets", "HIGH");
        }

        issue(id, {
          rule: "missing-pull-secret",
          severity: pulling ? "critical" : "info",
          title: "pull secret missing",
          detail: `It pulls images with the secret ${pullSecret.name}, which doesn't exist${pulling ? "" : "; its images still pull"}.`,
        });
      }
    }

    if (pulling) {
      const images = new Set(
        nodes[id].pods.flatMap((pod) =>
          pod.containers.filter((c) => IMAGE.test(c.state) && c.image).map((c) => c.image as string),
        ),
      );

      for (const image of images) {
        const host = registryOf(image);

        if (!PUBLIC_REGISTRIES.has(host)) {
          const registryId = `registry//${host}`;

          synthetic(registryId, "Image registry", host, "", "err", "pull fails");
          link(id, registryId, "pulls", `image ${image}`, "HIGH");
        }
      }
    }
  }

  function addPendingClaim(pvc: RawObject, pvcId: string) {
    const className: string | undefined = pvc.spec?.storageClassName;
    const node = nodes[pvcId];

    if (node.issues.length > 0) return;

    if (className && input.storageClasses.length > 0 && !storageClasses.has(className)) {
      link(pvcId, missing("StorageClass", "", className), "needs", "storageClassName", "HIGH");
    }

    issue(pvcId, {
      rule: "pvc-pending",
      severity: "critical",
      title: "Pending",
      detail: `The claim isn't bound to a volume${className ? ` of class ${className}` : ""}${className && input.storageClasses.length > 0 && !storageClasses.has(className) ? ", a class that doesn't exist" : ""}.`,
      since: time(pvc.metadata.creationTimestamp),
    });
  }

  // ---- nodes
  for (const k8sNode of input.nodes) {
    const name = k8sNode.metadata.name;
    const conditions: { type: string; status: string; message?: string; lastTransitionTime?: string }[] =
      k8sNode.status?.conditions ?? [];
    const readyCondition = conditions.find((c) => c.type === "Ready");
    const pressure = conditions.filter((c) => /Pressure$/.test(c.type) && c.status === "True");
    const id = `node//${name}`;
    const make = () => {
      const node = synthetic(id, "Node", name, "", "ok", "");

      node.synthetic = false;
      node.selfLink = k8sNode.metadata.selfLink;

      return node;
    };

    if (readyCondition && readyCondition.status !== "True") {
      make().sub = "NotReady";
      issue(id, {
        rule: "node-not-ready",
        severity: "critical",
        title: "NotReady",
        detail: `The node stopped reporting as ready${readyCondition.message ? `: ${readyCondition.message}` : "."}`,
        since: time(readyCondition.lastTransitionTime),
        message: readyCondition.message,
      });

      for (const owner of Object.values(nodes)) {
        if (owner.pods.some((pod) => pod.node === name)) {
          link(owner.id, id, "runs-on", "spec.nodeName", "HIGH");
        }
      }
    } else if (pressure.length > 0) {
      make().sub = pressure.map((c) => c.type).join(", ");
      issue(id, {
        rule: "node-pressure",
        severity: "warning",
        title: pressure.map((c) => c.type).join(", "),
        detail: `The node reports ${pressure.map((c) => c.type).join(" and ")}, so it may evict pods.`,
        since: minOf(...pressure.map((c) => time(c.lastTransitionTime))),
      });
    } else if (k8sNode.spec?.unschedulable) {
      make().sub = "cordoned";
      issue(id, {
        rule: "node-cordoned",
        severity: "info",
        title: "cordoned",
        detail: "The node is cordoned: no new pods are scheduled on it.",
      });
    }
  }

  // ---- references to Services that aren't there, from Topology
  for (const l of links.values()) {
    if (l.type === "calls" && nodes[l.to]?.health === "missing") {
      issue(l.from, {
        rule: "missing-service-ref",
        severity: "info",
        title: "names a missing Service",
        detail: `Its configuration names ${nodes[l.to].name}.${nodes[l.to].namespace}.svc, which is not among the Services in view.`,
      });
    }
  }

  // ---- events
  const events: EventRecord[] = [];
  const replicaSetOwner = new Map(
    withKind(input.replicaSets, "ReplicaSet").map((rs) => {
      const owner = ownerOf(rs);

      return [`${nsOf(rs)}/${rs.metadata.name}`, owner ? idOfWorkload(owner) : undefined];
    }),
  );
  const jobOwner = (namespace: string, name: string) => {
    const job = byName.get(`Job/${namespace}/${name}`);
    const parent = job ? ownerOf(job) : undefined;

    return parent?.kind === "CronJob" ? idOfWorkload(parent) : keyOf("Job", namespace, name);
  };

  for (const event of input.events) {
    if (event.type !== "Warning") continue;

    const involved = event.involvedObject ?? {};
    const namespace = involved.namespace ?? event.metadata.namespace ?? "";
    const name = involved.name ?? "";
    let nodeId: string | undefined;

    switch (involved.kind) {
      case "Pod":
        nodeId = podOwner.get(`${namespace}/${name}`);
        break;
      case "ReplicaSet":
        nodeId = replicaSetOwner.get(`${namespace}/${name}`);
        break;
      case "Job":
        nodeId = jobOwner(namespace, name);
        break;
      case "Node":
        nodeId = `node//${name}`;
        break;
      default:
        nodeId = involved.kind ? keyOf(involved.kind, namespace, name) : undefined;
    }

    if (!nodeId || !nodes[nodeId]) continue;

    const last =
      time(event.series?.lastObservedTime) ??
      time(event.lastTimestamp) ??
      time(event.eventTime) ??
      time(event.metadata.creationTimestamp);

    if (last === undefined) continue;

    const record: EventRecord = {
      nodeId,
      pod: involved.kind === "Pod" ? name : undefined,
      reason: event.reason ?? "Warning",
      message: event.message ?? "",
      first: time(event.firstTimestamp) ?? time(event.eventTime) ?? last,
      last,
      count: event.series?.count ?? event.count ?? 1,
    };

    events.push(record);
    nodes[nodeId].warningEvents += record.count;
  }

  const EVIDENCE: Partial<Record<RuleId, RegExp>> = {
    "not-ready": /Unhealthy/,
    crashloop: /BackOff|Unhealthy/,
    "image-pull": /Failed|ErrImagePull|BackOff/,
    unschedulable: /FailedScheduling/,
    "stuck-creating": /FailedMount|FailedAttachVolume|FailedCreatePodSandBox/,
    "stuck-init": /FailedMount|Unhealthy|BackOff/,
    "replica-shortfall": /FailedCreate/,
    "job-failed": /BackoffLimitExceeded|DeadlineExceeded/,
    "cronjob-failing": /BackoffLimitExceeded|DeadlineExceeded/,
    "pvc-pending": /ProvisioningFailed|FailedBinding/,
    "rollout-stuck": /FailedCreate/,
  };

  for (const i of issues) {
    const pattern = EVIDENCE[i.rule];

    if (!pattern) continue;

    const matching = events.filter((e) => e.nodeId === i.nodeId && pattern.test(e.reason));
    const newest = matching.sort((a, b) => b.last - a.last)[0];

    if (newest) {
      i.message ??= newest.message;
      i.since = minOf(i.since, ...matching.map((e) => e.first));
    }
  }

  // Services named in the Warning events of a failing workload: what it fails to reach.
  for (const record of events) {
    const node = nodes[record.nodeId];

    if (!node.issues.some((i) => i.severity !== "info") || !record.message) continue;

    for (const ref of findReferences(record.message, node.namespace, knownServices)) {
      const target = keyOf("Service", ref.namespace, ref.service);
      const ownService = [...links.values()].some((l) => l.type === "exposes" && l.from === target && l.to === node.id);

      if (!isApiServer(ref) && !ownService && nodes[target]) {
        link(node.id, target, "mentions", `Warning ${record.reason} ×${record.count}`, "MEDIUM");
      }
    }
  }

  // Many recent warnings on something no rule flagged: probes that flap, mounts that retry.
  for (const node of Object.values(nodes)) {
    if (node.issues.some((i) => i.severity !== "info")) continue;

    const recent = events.filter(
      (e) =>
        e.nodeId === node.id &&
        now - e.last < 30 * 60_000 &&
        /Unhealthy|BackOff|FailedMount|FailedScheduling|FailedCreate|^Failed$/.test(e.reason),
    );
    const count = recent.reduce((sum, e) => sum + e.count, 0);

    if (count >= 10) {
      const top = recent.sort((a, b) => b.count - a.count)[0];

      issue(node.id, {
        rule: "warning-events",
        severity: "warning",
        title: `${top.reason} ×${count}`,
        detail: `${count} Warning events in the last 30 minutes, mostly ${top.reason}.`,
        since: minOf(...recent.map((e) => e.first)),
        message: top.message,
        pod: top.pod,
      });
    }
  }

  // ---- health of each node
  for (const node of Object.values(nodes)) {
    const severity = node.issues.reduce<Severity | undefined>(
      (acc, i) => (i.severity === "info" ? acc : acc ? worse(acc, i.severity) : i.severity),
      undefined,
    );

    if (severity) {
      node.health = severity === "critical" ? "err" : "warn";
    } else if (node.issues.some((i) => i.rule === "scaled-to-zero")) {
      node.health = "idle";
    }

    const failingCount = node.pods.filter((p) => p.health === "err").length;
    const restarts = node.issues.find((i) => i.rule === "restarts");

    if (!node.badge && failingCount > 0 && node.pods.length > 1) {
      node.badge = `${failingCount}/${node.pods.length} failing`;
    } else if (!node.badge && restarts) {
      node.badge = restarts.title;
    } else if (!node.badge && node.warningEvents >= 10 && severity) {
      node.badge = `×${node.warningEvents}`;
    }
  }

  const allLinks = [...links.values()];
  const { incidents, housekeeping } = groupIncidents(nodes, allLinks, issues, events, now);

  return { nodes, links: allLinks, incidents, housekeeping, issueCount: issues.length, events };
}

// ---------------------------------------------------------------- incidents

const ROOT_RULES: RuleId[] = [
  "crashloop",
  "image-pull",
  "config-error",
  "oom",
  "unschedulable",
  "stuck-init",
  "stuck-creating",
  "not-ready",
  "pod-failed",
  "job-failed",
  "cronjob-failing",
  "pvc-pending",
  "node-not-ready",
  "node-pressure",
  "replica-shortfall",
  "rollout-stuck",
  "restarts",
  "warning-events",
];

/** Rules of an issue that is about a node it links to: a missing reference, a registry. */
const REFERRING_RULES: RuleId[] = [
  "missing-secret",
  "missing-configmap",
  "missing-pvc",
  "missing-pull-secret",
  "missing-gateway",
  "route-missing-service",
  "ingress-missing-service",
  "ingress-class-missing",
  "ingress-tls-missing",
  "image-pull",
  "pvc-pending",
  "node-not-ready",
];

/** How likely a node is to be where a chain of failures starts. */
function rootScore(node: MapNode): number {
  if (node.health === "missing") return 50;
  if (node.kind === "Image registry") return 45;
  if (node.kind === "Node") return 40;
  if (node.kind === "PersistentVolumeClaim") return 35;
  if (isWorkload(node.kind)) {
    return node.issues.some((i) => ROOT_RULES.includes(i.rule) && i.severity !== "info") ? 30 : 20;
  }
  if (node.kind === "Service") return 10;

  return 5;
}

function groupIncidents(
  nodes: Record<string, MapNode>,
  links: MapLink[],
  issues: Issue[],
  events: EventRecord[],
  now: number,
): { incidents: Incident[]; housekeeping: HousekeepingGroup[] } {
  const urgent = (id: string) => nodes[id]?.issues.some((i) => i.severity !== "info" && i.rule !== "lb-pending");
  const joins = (id: string) => urgent(id) || nodes[id]?.synthetic;
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;

    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root) as string;
    parent.set(id, root);

    return root;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));

  for (const id of Object.keys(nodes)) {
    if (urgent(id)) parent.set(id, id);
  }

  // Linked failures are one incident; a missing or made-up node joins the failures that need it.
  for (const l of links) {
    if (l.type === "needs" && nodes[l.to]?.id === "lbprovider//") continue;

    const firm = l.confidence === "HIGH" || (urgent(l.from) && urgent(l.to));

    if (firm && ((urgent(l.from) && joins(l.to)) || (urgent(l.to) && joins(l.from)))) {
      if (!parent.has(l.from)) parent.set(l.from, l.from);
      if (!parent.has(l.to)) parent.set(l.to, l.to);
      union(l.from, l.to);
    }
  }

  const components = new Map<string, string[]>();

  for (const id of parent.keys()) {
    const root = find(id);

    components.set(root, [...(components.get(root) ?? []), id]);
  }

  const incidents: Incident[] = [];
  // A missing or made-up node is as urgent as what fails because of it.
  const severityOf = (id: string, inner: MapLink[]): number => {
    const own = nodes[id].issues.filter((i) => i.severity !== "info" && i.rule !== "lb-pending");

    if (own.length > 0) {
      return Math.max(...own.map((i) => SEVERITY_RANK[i.severity]));
    }

    const referrers = inner.filter((l) => l.to === id).map((l) => nodes[l.from]);

    return Math.max(
      0,
      ...referrers.flatMap((r) =>
        r.issues
          .filter((i) => i.severity !== "info" && REFERRING_RULES.includes(i.rule))
          .map((i) => SEVERITY_RANK[i.severity]),
      ),
    );
  };

  for (const members of components.values()) {
    const memberSet = new Set(members);
    const memberIssues = members.flatMap((id) =>
      nodes[id].issues.filter((i) => i.severity !== "info" && i.rule !== "lb-pending"),
    );

    if (memberIssues.length === 0) continue;

    const inner = links.filter((l) => memberSet.has(l.from) && memberSet.has(l.to));
    const sinks = members.filter((id) => !inner.some((l) => l.from === id));
    const dependents = (id: string) => {
      const seen = new Set<string>([id]);
      const queue = [id];

      while (queue.length) {
        const current = queue.shift() as string;

        for (const l of inner) {
          if (l.to === current && !seen.has(l.from)) {
            seen.add(l.from);
            queue.push(l.from);
          }
        }
      }

      return seen.size - 1;
    };
    const candidates = sinks.length > 0 ? sinks : members;
    const rootId = candidates
      .map((id) => ({
        id,
        score: severityOf(id, inner) * 100_000 + rootScore(nodes[id]) * 1000 + dependents(id) * 10,
      }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))[0].id;

    incidents.push(makeIncident(nodes, links, events, now, members, rootId, memberIssues));
  }

  // LoadBalancer Services without an address share one cause, wherever they are.
  const pending = issues.filter((i) => i.rule === "lb-pending");

  if (pending.length > 0 && nodes["lbprovider//"]) {
    incidents.push(
      makeIncident(
        nodes,
        links.filter((l) => l.to === "lbprovider//"),
        events,
        now,
        [...pending.map((i) => i.nodeId), "lbprovider//"],
        "lbprovider//",
        pending,
      ),
    );
  }

  incidents.sort(
    (a, b) =>
      Number(b.severity === "critical") - Number(a.severity === "critical") ||
      b.issues.length - a.issues.length ||
      a.title.localeCompare(b.title),
  );

  // Housekeeping: the rest, by rule.
  const HOUSEKEEPING: Partial<Record<RuleId, [string, string]>> = {
    "scaled-to-zero": ["Workload scaled to 0", "Likely on purpose"],
    "service-no-pods": ["Service selects no pods", "Nothing sends traffic to it"],
    "old-failed-jobs": ["Old failed Jobs", "A newer run succeeded"],
    evicted: ["Evicted pods", "Left behind after an eviction"],
    "missing-service-ref": ["Configuration names a missing Service", "Maybe a default value, or out of view"],
    "ingress-no-address": ["Ingress without an address", "Some controllers never set one"],
    "missing-pull-secret": ["Pull secret that doesn't exist", "Its images still pull"],
    oom: ["Killed for memory a while ago", "Over a day ago, running since"],
    "node-cordoned": ["Cordoned node", "No new pods go there"],
  };
  const groups = new Map<RuleId, Issue[]>();

  for (const i of issues) {
    if (i.severity === "info") groups.set(i.rule, [...(groups.get(i.rule) ?? []), i]);
  }

  const housekeeping = [...groups.entries()]
    .map(([rule, list]) => {
      const [title, note] = HOUSEKEEPING[rule] ?? [list[0].title, ""];
      const names = list.map((i) => nodes[i.nodeId]?.name ?? i.nodeId);

      return { rule, title, note: [note, sample(names)].filter(Boolean).join(" · "), count: list.length, issues: list };
    })
    .sort((a, b) => b.count - a.count);

  return { incidents, housekeeping };
}

const TAGS: Partial<Record<RuleId, string>> = {
  crashloop: "CrashLoopBackOff",
  "image-pull": "ImagePullBackOff",
  "config-error": "Config error",
  oom: "OOMKilled",
  unschedulable: "Unschedulable",
  "stuck-init": "Init",
  "stuck-creating": "ContainerCreating",
  "not-ready": "Readiness",
  "job-failed": "Batch",
  "cronjob-failing": "Batch",
  "missing-secret": "Missing reference",
  "missing-configmap": "Missing reference",
  "missing-pvc": "Missing reference",
  "missing-pull-secret": "Missing reference",
  "missing-gateway": "Missing reference",
  "route-missing-service": "Routing",
  "ingress-missing-service": "Routing",
  "ingress-class-missing": "Routing",
  "lb-pending": "Networking",
  "pvc-pending": "Storage",
  "node-not-ready": "Node",
  "node-pressure": "Node",
  restarts: "Restarts",
  "rollout-stuck": "Rollout",
};

const LINK_FACT: Record<LinkType, (count: number, target: string) => string> = {
  exposes: (n, t) => `${plural(n, "Service")} ${n === 1 ? "selects" : "select"} the pods of ${t} (selector)`,
  routes: (n, t) => `${plural(n, "route")} ${n === 1 ? "sends" : "send"} traffic to ${t} (spec)`,
  calls: (n, t) => `${plural(n, "workload")} ${n === 1 ? "names" : "name"} ${t} in its configuration`,
  mentions: (n, t) => `${plural(n, "workload")} ${n === 1 ? "names" : "name"} ${t} in Warning events`,
  uses: (n, t) => `${plural(n, "workload")} ${n === 1 ? "references" : "reference"} ${t} (spec)`,
  pulls: (n, t) => `${plural(n, "workload")} ${n === 1 ? "pulls" : "pull"} images from ${t}`,
  "runs-on": (n, t) => `${plural(n, "workload")} ${n === 1 ? "has" : "have"} pods on ${t}`,
  needs: (n, t) => `${plural(n, "object")} ${n === 1 ? "needs" : "need"} ${t}`,
};

function makeIncident(
  nodes: Record<string, MapNode>,
  links: MapLink[],
  events: EventRecord[],
  now: number,
  members: string[],
  rootId: string,
  memberIssues: Issue[],
): Incident {
  const root = nodes[rootId];
  const memberSet = new Set(members);
  const inner = links.filter((l) => memberSet.has(l.from) && memberSet.has(l.to));

  // Healthy things that send traffic into the incident: at risk.
  const atRisk = new Set<string>();
  let frontier = [...members];

  for (let depth = 0; depth < 2 && frontier.length; depth++) {
    const next: string[] = [];

    for (const l of links) {
      if (
        frontier.includes(l.to) &&
        !memberSet.has(l.from) &&
        !atRisk.has(l.from) &&
        l.type !== "needs" &&
        nodes[l.from]?.health !== "missing" &&
        atRisk.size < 40
      ) {
        atRisk.add(l.from);
        next.push(l.from);
      }
    }

    frontier = next;
  }

  const shown = new Set([...members, ...atRisk]);
  const incidentLinks = links.filter((l) => shown.has(l.from) && shown.has(l.to));
  const namespaces = [...new Set(members.map((id) => nodes[id].namespace).filter(Boolean))].sort();
  const rootIssue =
    [...root.issues].sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        ROOT_RULES.indexOf(a.rule) - ROOT_RULES.indexOf(b.rule),
    )[0] ?? memberIssues[0];
  const severity = memberIssues.some((i) => i.severity === "critical") ? "critical" : "warning";
  const since = minOf(...memberIssues.map((i) => i.since));
  const dependentsOfRoot = inner.filter((l) => l.to === rootId).map((l) => nodes[l.from]);
  const explained = explain(root, rootIssue, dependentsOfRoot, memberIssues, nodes, members);

  // Why these belong together: the links, by kind and target.
  const facts: Fact[] = [];
  const byKind = new Map<string, MapLink[]>();

  for (const l of inner) {
    const key = `${l.type}>${l.to}`;

    byKind.set(key, [...(byKind.get(key) ?? []), l]);
  }

  for (const list of [...byKind.values()].sort((a, b) => b.length - a.length).slice(0, 5)) {
    const target = nodes[list[0].to];
    const targetName = `${target.kind === "Image registry" || target.kind === "Controller" ? "" : `${target.kind} `}${target.namespace ? `${target.namespace}/` : ""}${target.name}`;

    facts.push({
      confidence: list[0].confidence,
      text: LINK_FACT[list[0].type](new Set(list.map((l) => l.from)).size, targetName),
      count: list.length,
    });
  }

  if (members.length > 1 && namespaces.length > 1 && facts.length === 0) {
    facts.push({ confidence: "LOW", text: "They fail at the same time", count: members.length });
  }

  facts.push({
    confidence: "",
    text: `${members.length > 1 ? "Root" : "Only"}: ${root.kind} ${root.namespace ? `${root.namespace}/` : ""}${root.name}, ${root.health === "missing" ? "does not exist" : root.sub.replace(`${root.kind} · `, "") || rootIssue?.title || ""}`,
    count: 0,
  });

  // What changed: the Warning events of everything in the incident, last 6 hours.
  const end = now;
  const start = now - 6 * 60 * 60_000;
  const span = end - start;
  const at = (t: number) => Math.min(1, Math.max(0, (t - start) / span));
  const rowsByReason = new Map<string, EventRecord[]>();

  for (const e of events) {
    if (memberSet.has(e.nodeId) && e.last >= start) {
      rowsByReason.set(e.reason, [...(rowsByReason.get(e.reason) ?? []), e]);
    }
  }

  const rows: TimelineRow[] = [...rowsByReason.entries()]
    .map(([reason, list]) => {
      const total = list.reduce((sum, e) => sum + e.count, 0);
      const owners = new Set(list.map((e) => e.nodeId));

      return {
        label: `${reason} ×${total}${owners.size > 1 ? ` · ${owners.size} objects` : ` · ${nodes[list[0].nodeId].name}`}`,
        tone: (/Unhealthy|Failed|BackOff|Error|Kill/.test(reason) ? "err" : "warn") as "err" | "warn",
        bands: list
          .filter((e) => e.count > 1 && e.last > e.first)
          .map((e) => [at(e.first), at(e.last)] as [number, number]),
        ticks: [...new Set(list.map((e) => Math.round(at(e.last) * 200) / 200))],
        total,
      };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 4)
    .map(({ total: _total, ...row }) => row);

  const isolated = members.length === 1;
  const ruleTags = [...new Set(memberIssues.map((i) => TAGS[i.rule]).filter((t): t is string => Boolean(t)))];

  return {
    id: `${rootIssue?.rule ?? "issue"}:${rootId}`,
    severity,
    title: explained.title,
    meta: [
      plural(memberIssues.length, "issue"),
      namespaces.length === 1 ? namespaces[0] : namespaces.length > 1 ? plural(namespaces.length, "namespace") : "",
      atRisk.size > 0 ? `${atRisk.size} at risk` : "",
    ]
      .filter(Boolean)
      .join(" · "),
    tags: ruleTags.slice(0, 3),
    since,
    sinceText:
      since !== undefined
        ? `Since ${ago(now - since)} ago`
        : root.health === "missing"
          ? "Since the references were made"
          : "Onset unknown",
    rootId,
    isolated,
    nodeIds: members,
    atRiskIds: [...atRisk],
    links: incidentLinks,
    cause: explained.cause,
    risk:
      explained.risk ||
      (atRisk.size === 1
        ? "1 healthy object sends traffic here and breaks if this stays down."
        : atRisk.size > 1
          ? `${atRisk.size} healthy objects send traffic here and break if this stays down.`
          : ""),
    facts,
    action: explained.action,
    cmd: explained.cmd,
    primary: explained.primary,
    issues: memberIssues,
    namespaces,
    timeline: { rows, start, end },
  };
}

interface Explained {
  title: string;
  cause: string;
  risk: string;
  action: string;
  cmd: string;
  primary: Incident["primary"];
}

/** The words of an incident, from the issue of its root. */
function explain(
  root: MapNode,
  issue: Issue | undefined,
  dependents: MapNode[],
  memberIssues: Issue[],
  nodes: Record<string, MapNode>,
  members: string[],
): Explained {
  const ns = root.namespace;
  const n = (flag: string) => (ns ? `-n ${ns} ${flag}` : flag).trim();
  const pod = issue?.pod ?? root.pods.find((p) => p.health === "err")?.name ?? root.pods[0]?.name;
  const others = members.length - 1;
  const after = others > 0 ? ` ${plural(others, "other object")} fail${others === 1 ? "s" : ""} with it.` : "";
  const message = issue?.message ? ` Kubernetes says: “${issue.message.slice(0, 220)}”.` : "";
  const details: Incident["primary"] = { label: `Open ${root.name}`, nodeId: root.id };
  const logs = (previous = false): Incident["primary"] =>
    pod
      ? {
          label: `Open ${pod} logs`,
          nodeId: root.id,
          pod,
          container: issue?.container,
          previous,
        }
      : details;
  const container = issue?.container ? ` -c ${issue.container}` : "";

  if (root.id === "lbprovider//") {
    const users = dependents.map((d) => `${d.namespace}/${d.name}`);

    return {
      title: `No LoadBalancer controller: ${plural(users.length, "Service")} wait${users.length === 1 ? "s" : ""} for an address`,
      cause: `Services of type LoadBalancer only get an address from a controller such as MetalLB or a cloud provider. ${sample(users)} never got one.`,
      risk: "They are still reachable inside the cluster and through their NodePort.",
      action: "Install a LoadBalancer provider, or switch these Services to ClusterIP behind the ingress gateway.",
      cmd: "kubectl get svc -A --field-selector spec.type=LoadBalancer",
      primary: dependents[0] ? { label: `Open ${dependents[0].name}`, nodeId: dependents[0].id } : details,
    };
  }

  if (root.health === "missing") {
    const users = dependents.map((d) => d.name);
    const kindText = root.kind === "Service" ? "Service" : root.kind;
    const createCmd: Record<string, string> = {
      Secret: `kubectl ${n("create secret generic")} ${root.name} --from-literal=…`,
      ConfigMap: `kubectl ${n("create configmap")} ${root.name} --from-file=…`,
      PersistentVolumeClaim: `kubectl ${n("get pvc")}`,
      Gateway: `kubectl ${n("get gateways.networking.istio.io")}`,
      Service: `kubectl ${n("get svc")}`,
      IngressClass: "kubectl get ingressclass",
      StorageClass: "kubectl get storageclass",
    };
    const pullSecret = memberIssues.some((i) => i.rule === "missing-pull-secret" && i.severity === "critical");
    const missingCount = members.filter((id) => nodes[id].health === "missing").length;

    return {
      title:
        missingCount > 1 && ns ? `${ns} references things that don't exist` : `${kindText} ${root.name} doesn't exist`,
      cause: `${sample(users) || "Something"} ${users.length === 1 ? "references" : "reference"} ${kindText} ${ns ? `${ns}/` : ""}${root.name}, which doesn't exist${memberIssues.some((i) => i.severity === "critical") ? ", so their pods can't start" : ""}.${after}`,
      risk: "",
      action: pullSecret
        ? `Create the pull secret in namespace ${ns}, or remove the reference if the image is public.`
        : root.kind === "Service" || root.kind === "Gateway"
          ? `Point the reference at the right ${kindText}, or create it.`
          : `Create ${kindText} ${root.name}, or remove the reference.`,
      cmd: pullSecret
        ? `kubectl ${n("create secret docker-registry")} ${root.name} --docker-server=…`
        : (createCmd[root.kind] ?? `kubectl ${n("get")} ${root.kind.toLowerCase()}`),
      primary: dependents[0] ? { label: `Open ${dependents[0].name}`, nodeId: dependents[0].id } : details,
    };
  }

  if (root.kind === "Image registry") {
    const users = dependents.map((d) => d.name);

    return {
      title: `Images from ${root.name} can't be pulled`,
      cause: `${sample(users)} ${users.length === 1 ? "is" : "are"} stuck in ImagePullBackOff on images from ${root.name}.${message}`,
      risk: "",
      action: "Check that the tags exist and that the pull secret is valid for this registry.",
      cmd: dependents[0] ? `kubectl -n ${dependents[0].namespace} get events --field-selector reason=Failed` : "",
      primary: dependents[0] ? { label: `Open ${dependents[0].name}`, nodeId: dependents[0].id } : details,
    };
  }

  switch (issue?.rule) {
    case "crashloop":
      return {
        title: `${root.name} keeps crashing`,
        cause: `${issue.detail}${message}${after}`,
        risk: "",
        action: "Read the logs of the previous run: why it stopped is usually in its last lines.",
        cmd: pod ? `kubectl ${n("logs")} ${pod}${container} --previous --tail=50` : "",
        primary: logs(true),
      };
    case "oom":
      return {
        title: `${root.name} runs out of memory`,
        cause: `${issue.detail}${after}`,
        risk: "",
        action: `Raise the memory limit of ${issue.container ?? "the container"}, or find what grew.`,
        cmd: pod ? `kubectl ${n("describe pod")} ${pod}` : "",
        primary: logs(true),
      };
    case "image-pull":
      return {
        title: `${root.name} can't pull its image`,
        cause: `${issue.detail}${message}${after}`,
        risk: "",
        action: "Check that the tag exists and that the pull secret is valid for the registry.",
        cmd: pod ? `kubectl ${n("describe pod")} ${pod}` : "",
        primary: details,
      };
    case "config-error":
      return {
        title: `${root.name} can't create its containers`,
        cause: `${issue.detail}${after}`,
        risk: "",
        action: "Fix what the message names: usually a Secret or ConfigMap key that isn't there.",
        cmd: pod ? `kubectl ${n("describe pod")} ${pod}` : "",
        primary: details,
      };
    case "unschedulable":
      return {
        title: `${root.name} can't be scheduled`,
        cause: `${issue.detail}${after}`,
        risk: "",
        action: "Free resources on the nodes, or relax the pod's requests, node selector, affinity or tolerations.",
        cmd: pod ? `kubectl ${n("describe pod")} ${pod}` : "",
        primary: details,
      };
    case "stuck-init":
      return {
        title: `${root.name} is stuck initializing`,
        cause: `${issue.detail}${message}${after}`,
        risk: "",
        action: "Read the logs of the init container: it usually waits for something it can't reach.",
        cmd: pod ? `kubectl ${n("logs")} ${pod}${container}` : "",
        primary: logs(),
      };
    case "stuck-creating":
      return {
        title: `${root.name} can't start its containers`,
        cause: `${issue.detail}${message}${after}`,
        risk: "",
        action: "Look at the pod's events: a volume that can't be mounted is the usual cause.",
        cmd: pod ? `kubectl ${n("describe pod")} ${pod}` : "",
        primary: details,
      };
    case "not-ready":
      return {
        title: `${root.name} is ${issue.severity === "critical" ? "unavailable" : "degraded"}`,
        cause: `${root.sub ? `${root.kind} ${root.name}: ${root.sub.replace(/^\w+ · /, "")}. ` : ""}${issue.detail}${message}${after}`,
        risk: "",
        action: "Read its logs to see why the readiness probe fails.",
        cmd: pod ? `kubectl ${n("logs")} ${pod}${container} --tail=100` : "",
        primary: logs(),
      };
    case "job-failed":
    case "cronjob-failing":
      return {
        title: issue.rule === "job-failed" ? `Job ${root.name} failed` : `${root.name} keeps failing`,
        cause: `${issue.detail}${message}${after}`,
        risk: "",
        action: "Read the logs of the newest failed run first. Its pod may still exist; older ones may be gone.",
        cmd: issue.pod ? `kubectl ${n("logs")} job/${issue.pod}` : "",
        primary: details,
      };
    case "pvc-pending":
      return {
        title: `${root.name} is not bound`,
        cause: `${issue.detail}${message}${after}`,
        risk: "",
        action: "Check that its StorageClass exists and has a provisioner that works.",
        cmd: `kubectl ${n("describe pvc")} ${root.name}`,
        primary: details,
      };
    case "node-not-ready":
    case "node-pressure":
      return {
        title: `Node ${root.name} is ${issue.rule === "node-not-ready" ? "NotReady" : "under pressure"}`,
        cause: `${issue.detail}${after}`,
        risk: "",
        action: "Look at the node's conditions and its kubelet.",
        cmd: `kubectl describe node ${root.name}`,
        primary: details,
      };
    case "service-no-endpoints":
    case "service-no-pods":
      return {
        title: `${root.name} has no endpoints`,
        cause: `${issue.detail}${after}`,
        risk: "",
        action: "Check its selector against the labels of the pods it should send to.",
        cmd: `kubectl ${n("get endpointslices")} -l kubernetes.io/service-name=${root.name}`,
        primary: details,
      };
    case "missing-gateway":
    case "route-missing-service":
    case "ingress-missing-service":
    case "ingress-class-missing":
    case "ingress-tls-missing":
      return {
        title: `${root.name} points at something that doesn't exist`,
        cause: `${issue.detail}${after}`,
        risk: "",
        action: "Fix the reference, or remove the route if it is no longer used.",
        cmd: `kubectl ${n("get")} ${root.kind.toLowerCase()} ${root.name} -o yaml`,
        primary: details,
      };
    case "restarts":
      return {
        title: `${root.name} restarts often`,
        cause: `${issue.detail}${after}`,
        risk: "",
        action: "Read the logs of the previous run to see why it stopped.",
        cmd: pod ? `kubectl ${n("logs")} ${pod}${container} --previous --tail=50` : "",
        primary: logs(true),
      };
    default:
      return {
        title: `${root.name}: ${issue?.title ?? "problem"}`,
        cause: `${issue?.detail ?? ""}${message}${after}`.trim(),
        risk: "",
        action: "Look at its events and details.",
        cmd: root.kind && ns ? `kubectl ${n("describe")} ${root.kind.toLowerCase()} ${root.name}` : "",
        primary: details,
      };
  }
}

// ---------------------------------------------------------------- pods view

export interface PodBox {
  id: string;
  title: string;
  sub: string;
  health: Health;
  root: boolean;
  atRisk: boolean;
  /** Not in the incident itself: the pods behind a Service or route that is */
  behind?: string;
  pods: PodInfo[];
  badge?: string;
}

/**
 * The workloads whose pods an incident is about: those in it, and, for a Service or a route
 * in it, the workloads it sends traffic to, found by following its routes and selectors.
 */
export function workloadsOf(report: HealthReport, incident: Incident): { id: string; behind?: string }[] {
  const { nodes, links } = report;
  const found = new Map<string, string | undefined>();
  const start = [...incident.nodeIds, ...incident.atRiskIds];

  for (const id of start) {
    if (nodes[id]?.pods.length > 0) {
      found.set(id, undefined);
    }
  }

  // Only for what is in the incident: a healthy Service at risk may select many unrelated pods.
  for (const id of incident.nodeIds) {
    if (nodes[id]?.pods.length > 0) continue;

    let frontier = [id];
    const seen = new Set(frontier);

    for (let depth = 0; depth < 4 && frontier.length; depth++) {
      const next: string[] = [];

      for (const l of links) {
        if (!frontier.includes(l.from) || seen.has(l.to) || (l.type !== "routes" && l.type !== "exposes")) continue;

        seen.add(l.to);

        if (nodes[l.to]?.pods.length > 0) {
          if (!found.has(l.to)) found.set(l.to, `${nodes[id].kind} ${nodes[id].name}`);
        } else {
          next.push(l.to);
        }
      }

      frontier = next;
    }
  }

  return [...found.entries()].map(([id, behind]) => ({ id, behind }));
}

/**
 * The pods of an incident, in one box per workload or per node, and the links between workload
 * boxes, through the Services in between.
 */
export function podBoxes(
  report: HealthReport,
  incident: Incident,
  by: "workload" | "node",
): { boxes: PodBox[]; links: { from: string; to: string; tone: "err" | "ok" }[] } {
  const { nodes } = report;
  const workloads = workloadsOf(report, incident);
  const withPods = workloads.map((w) => w.id);

  if (by === "node") {
    const byNode = new Map<string, PodInfo[]>();

    for (const id of withPods) {
      for (const pod of nodes[id].pods) {
        const key = pod.node || "not scheduled";

        byNode.set(key, [...(byNode.get(key) ?? []), pod]);
      }
    }

    return {
      boxes: [...byNode.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, list]) => {
          const failing = list.filter((p) => p.health === "err").length;

          return {
            id: `node//${name}`,
            title: name,
            sub: `Node · ${plural(list.length, "pod")}`,
            health: nodes[`node//${name}`]?.health ?? (failing ? "warn" : "ok"),
            root: incident.rootId === `node//${name}`,
            atRisk: false,
            pods: list,
            badge: failing ? `${failing} failing` : undefined,
          };
        }),
      links: [],
    };
  }

  const boxes = workloads.map(({ id, behind }) => {
    const node = nodes[id];
    const failing = node.pods.filter((p) => p.health === "err").length;

    return {
      id,
      title: node.name,
      sub: `${node.kind}${node.namespace ? ` · ${node.namespace}` : ""}`,
      health: node.health,
      root: incident.rootId === id,
      atRisk: incident.atRiskIds.includes(id),
      behind,
      pods: node.pods,
      badge: failing ? `${failing}/${node.pods.length} failing` : node.badge,
    };
  });
  const boxIds = new Set(boxes.map((b) => b.id));
  const out = new Map<string, { from: string; to: string; tone: "err" | "ok" }>();

  // Workload -> workload, directly or through a Service that exposes the target.
  for (const l of report.links) {
    if (!boxIds.has(l.from) || l.type === "exposes") continue;

    const targets = boxIds.has(l.to)
      ? [l.to]
      : report.links.filter((e) => e.type === "exposes" && e.from === l.to && boxIds.has(e.to)).map((e) => e.to);

    for (const to of targets) {
      if (to !== l.from) {
        out.set(`${l.from}>${to}`, { from: l.from, to, tone: nodes[to].health === "err" ? "err" : "ok" });
      }
    }
  }

  return { boxes, links: [...out.values()] };
}
