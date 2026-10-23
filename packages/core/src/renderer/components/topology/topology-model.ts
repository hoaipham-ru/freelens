/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Builds the Topology graph from plain Kubernetes manifests. Pure: no stores, no DI,
// so every rule here is unit-tested with fixtures.
//
// Two views:
// - "architecture": Ingress -> Service -> workload. Pods, ConfigMaps, Secrets, PVCs,
//   ServiceAccounts, PDBs and NetworkPolicies are folded into the workload card.
// - "network": outside -> Ingress / Service -> each pod, with ports.
// Both add "calls" edges inferred from configuration: a Service's DNS name or URL found
// in a workload's env values or in the ConfigMaps it reads.

export type TopologyMode = "architecture" | "network";
export type TopologyStatus = "ok" | "warn" | "err" | "idle";
export type TopologyEdgeType = "routes" | "exposes" | "calls";

export interface RawObject {
  kind?: string;
  apiVersion?: string;
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    labels?: Record<string, string>;
    ownerReferences?: { kind: string; name: string; uid?: string }[];
    selfLink?: string;
  };
  spec?: any;
  status?: any;
  data?: Record<string, string>;
}

export interface TopologyInput {
  ingresses: RawObject[];
  services: RawObject[];
  deployments: RawObject[];
  statefulSets: RawObject[];
  daemonSets: RawObject[];
  replicaSets: RawObject[];
  cronJobs: RawObject[];
  jobs: RawObject[];
  pods: RawObject[];
  configMaps: RawObject[];
  persistentVolumeClaims: RawObject[];
  podDisruptionBudgets: RawObject[];
  networkPolicies: RawObject[];
}

export interface TopologyAttachment {
  kind: "ConfigMap" | "Secret" | "PersistentVolumeClaim" | "ServiceAccount" | "PodDisruptionBudget" | "NetworkPolicy";
  short: "cm" | "secret" | "pvc" | "sa" | "pdb" | "np";
  name: string;
}

export interface TopologyPodSummary {
  name: string;
  status: TopologyStatus;
  reason: string;
}

export interface TopologyNode {
  id: string;
  kind: string;
  name: string;
  namespace: string;
  group: string;
  status: TopologyStatus;
  summary: string;
  flags: { text: string; detail: string }[];
  pods: TopologyPodSummary[];
  attachments: TopologyAttachment[];
  outsideView: boolean;
  selfLink?: string;
  column: number;
}

export interface TopologyEdge {
  id: string;
  from: string;
  to: string;
  type: TopologyEdgeType;
  via: string;
  inferred: boolean;
}

export interface TopologyGraph {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  hiddenCount: number;
}

const WORKLOAD_KINDS = ["Deployment", "StatefulSet", "DaemonSet", "CronJob", "Job"] as const;
const OUTSIDE = "outside";

// ---------------------------------------------------------------- helpers

const keyOf = (kind: string, namespace: string, name: string) => `${kind.toLowerCase()}/${namespace}/${name}`;
const nsOf = (o: RawObject) => o.metadata.namespace ?? "";

export function groupLabelOf(labels: Record<string, string> | undefined): string {
  return (
    labels?.["app.kubernetes.io/name"] ??
    labels?.app ??
    labels?.["app.kubernetes.io/instance"] ??
    labels?.["k8s-app"] ??
    ""
  );
}

interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: { key: string; operator: string; values?: string[] }[];
}

/**
 * Service selectors are plain maps; workload, PDB and NetworkPolicy selectors are LabelSelectors.
 * The two differ when empty: `{}` as a Service selector selects nothing, as a LabelSelector everything.
 */
export function selectorMatches(
  selector: LabelSelector | Record<string, string> | undefined,
  labels: Record<string, string> = {},
  isLabelSelector = selector !== undefined && ("matchLabels" in selector || "matchExpressions" in selector),
): boolean {
  if (!selector) {
    return false;
  }

  const matchLabels =
    (isLabelSelector ? (selector as LabelSelector).matchLabels : (selector as Record<string, string>)) ?? {};
  const expressions = isLabelSelector ? ((selector as LabelSelector).matchExpressions ?? []) : [];

  if (Object.keys(matchLabels).length === 0 && expressions.length === 0) {
    // An empty LabelSelector selects everything (PDB, NetworkPolicy); an empty Service selector selects nothing.
    return isLabelSelector;
  }

  for (const [key, value] of Object.entries(matchLabels)) {
    if (labels[key] !== value) {
      return false;
    }
  }

  return expressions.every(({ key, operator, values = [] }) => {
    switch (operator) {
      case "In":
        return key in labels && values.includes(labels[key]);
      case "NotIn":
        return !(key in labels) || !values.includes(labels[key]);
      case "Exists":
        return key in labels;
      case "DoesNotExist":
        return !(key in labels);
      default:
        return false;
    }
  });
}
function podTemplateOf(o: RawObject): { labels: Record<string, string>; spec: any } {
  if (o.kind === "Pod") {
    return { labels: o.metadata.labels ?? {}, spec: o.spec ?? {} };
  }

  const template = o.kind === "CronJob" ? o.spec?.jobTemplate?.spec?.template : o.spec?.template;

  return { labels: template?.metadata?.labels ?? {}, spec: template?.spec ?? {} };
}

export function podStatusOf(pod: RawObject): TopologyPodSummary {
  const name = pod.metadata.name;
  const phase: string = pod.status?.phase ?? "Unknown";
  const statuses: { ready?: boolean; state?: { waiting?: { reason?: string } } }[] = [
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.containerStatuses ?? []),
  ];
  const waiting = statuses
    .map((s) => s.state?.waiting?.reason)
    .find((reason) => reason && reason !== "PodInitializing");

  if (waiting && /BackOff|Err|Invalid|Error/.test(waiting)) {
    return { name, status: "err", reason: waiting };
  }

  if (phase === "Failed") {
    return { name, status: "err", reason: pod.status?.reason ?? "Failed" };
  }

  if (phase === "Succeeded") {
    return { name, status: "idle", reason: "Completed" };
  }

  if (phase === "Running") {
    const containers: { ready?: boolean }[] = pod.status?.containerStatuses ?? [];
    const ready = containers.length > 0 && containers.every((c) => c.ready);

    return ready ? { name, status: "ok", reason: "Running" } : { name, status: "warn", reason: waiting ?? "Not ready" };
  }

  return { name, status: "warn", reason: waiting ?? phase };
}

function workloadReadiness(o: RawObject, pods: TopologyPodSummary[]): { status: TopologyStatus; summary: string } {
  switch (o.kind) {
    case "Deployment":
    case "StatefulSet": {
      const desired: number = o.spec?.replicas ?? 1;
      const ready: number = o.status?.readyReplicas ?? 0;

      return readiness(ready, desired);
    }
    case "DaemonSet":
      return readiness(o.status?.numberReady ?? 0, o.status?.desiredNumberScheduled ?? 0);
    case "CronJob":
      return o.spec?.suspend
        ? { status: "idle", summary: "suspended" }
        : { status: "ok", summary: o.spec?.schedule ?? "" };
    case "Job": {
      if ((o.status?.failed ?? 0) > 0 && !(o.status?.succeeded > 0)) {
        return { status: "err", summary: `${o.status.failed} failed` };
      }

      return o.status?.succeeded > 0 ? { status: "idle", summary: "completed" } : { status: "ok", summary: "running" };
    }
    default: {
      const worst = pods.find((p) => p.status === "err") ?? pods.find((p) => p.status === "warn");

      return worst ? { status: worst.status, summary: worst.reason } : { status: "ok", summary: "running" };
    }
  }
}

function readiness(ready: number, desired: number): { status: TopologyStatus; summary: string } {
  if (desired === 0) {
    return { status: "idle", summary: "scaled to 0" };
  }

  return { status: ready >= desired ? "ok" : ready === 0 ? "err" : "warn", summary: `${ready}/${desired} ready` };
}

function portsOf(service: RawObject): string {
  const ports: { port?: number }[] = service.spec?.ports ?? [];

  if (ports.length === 0) {
    return "";
  }

  return ports.length > 1 ? `${ports[0].port} +${ports.length - 1}` : `${ports[0].port}`;
}

// ---------------------------------------------------------------- inferred calls

export interface CallReference {
  namespace: string;
  service: string;
  port?: string;
}

const DNS_IN_TEXT = /\b((?:[a-z0-9](?:[-a-z0-9]*[a-z0-9])?\.){2,4}svc(?:\.cluster\.local)?)(?::(\d{2,5}))?/g;
const URL_HOST =
  /\b[a-z][a-z0-9+.-]*:\/\/([a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)?)(?::(\d{2,5}))?/g;
const HOST_PORT =
  /(?:^|[\s"'=,;(@/])([a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)?):(\d{2,5})\b/g;

/**
 * Finds references to Services in a piece of configuration text. Fully qualified names
 * (`name.ns.svc`, `pod.name.ns.svc`) always count; short names (`name:port`, `scheme://name`,
 * `name.ns`) only count when such a Service exists, so ordinary words are not mistaken for hosts.
 */
export function findServiceReferences(text: string, ownNamespace: string, knownServices: Set<string>): CallReference[] {
  const found = new Map<string, CallReference>();
  const add = (namespace: string, service: string, port?: string) => {
    const key = `${namespace}/${service}`;

    if (!found.has(key) || (!found.get(key)?.port && port)) {
      found.set(key, { namespace, service, port });
    }
  };
  const lower = text.toLowerCase();

  for (const match of lower.matchAll(DNS_IN_TEXT)) {
    const labels = match[1].split(".");
    const svcIndex = labels.indexOf("svc");

    if (svcIndex >= 2) {
      add(labels[svcIndex - 1], labels[svcIndex - 2], match[2]);
    }
  }

  const tryShort = (host: string, port?: string) => {
    if (host.endsWith(".svc") || host.includes(".svc.")) {
      return;
    }

    const [first, second] = host.split(".");
    const namespace = second ?? ownNamespace;

    if (knownServices.has(`${namespace}/${first}`)) {
      add(namespace, first, port);
    }
  };

  for (const match of lower.matchAll(URL_HOST)) {
    tryShort(match[1], match[2]);
  }

  for (const match of lower.matchAll(HOST_PORT)) {
    tryShort(match[1], match[2]);
  }

  return [...found.values()];
}

interface ConfigSource {
  text: string;
  via: string;
}
function configSourcesOf(podSpec: any, namespace: string, configMaps: Map<string, RawObject>): ConfigSource[] {
  const sources: ConfigSource[] = [];
  const containers = [...(podSpec?.initContainers ?? []), ...(podSpec?.containers ?? [])];
  const configMapNames = new Set<string>();

  for (const container of containers) {
    for (const env of container.env ?? []) {
      if (typeof env.value === "string" && env.value) {
        sources.push({ text: env.value, via: `env ${env.name}` });
      }

      if (env.valueFrom?.configMapKeyRef?.name) {
        configMapNames.add(env.valueFrom.configMapKeyRef.name);
      }
    }

    for (const envFrom of container.envFrom ?? []) {
      if (envFrom.configMapRef?.name) {
        configMapNames.add(envFrom.configMapRef.name);
      }
    }

    for (const arg of [...(container.args ?? []), ...(container.command ?? [])]) {
      if (typeof arg === "string") {
        sources.push({ text: arg, via: `args of ${container.name}` });
      }
    }
  }

  for (const volume of podSpec?.volumes ?? []) {
    if (volume.configMap?.name) {
      configMapNames.add(volume.configMap.name);
    }

    for (const source of volume.projected?.sources ?? []) {
      if (source.configMap?.name) {
        configMapNames.add(source.configMap.name);
      }
    }
  }

  for (const name of configMapNames) {
    const configMap = configMaps.get(`${namespace}/${name}`);

    for (const [key, value] of Object.entries(configMap?.data ?? {})) {
      sources.push({ text: value, via: `${key} in ConfigMap ${name}` });
    }
  }

  return sources;
}
function attachmentsOf(
  o: RawObject,
  podSpec: any,
  labels: Record<string, string>,
  input: TopologyInput,
): TopologyAttachment[] {
  const namespace = nsOf(o);
  const out: TopologyAttachment[] = [];
  const seen = new Set<string>();
  const add = (a: TopologyAttachment) => {
    const key = `${a.kind}/${a.name}`;

    if (!seen.has(key)) {
      seen.add(key);
      out.push(a);
    }
  };
  const containers = [...(podSpec?.initContainers ?? []), ...(podSpec?.containers ?? [])];

  for (const volume of podSpec?.volumes ?? []) {
    if (volume.configMap?.name) add({ kind: "ConfigMap", short: "cm", name: volume.configMap.name });
    if (volume.secret?.secretName) add({ kind: "Secret", short: "secret", name: volume.secret.secretName });
    if (volume.persistentVolumeClaim?.claimName)
      add({ kind: "PersistentVolumeClaim", short: "pvc", name: volume.persistentVolumeClaim.claimName });

    for (const source of volume.projected?.sources ?? []) {
      if (source.configMap?.name) add({ kind: "ConfigMap", short: "cm", name: source.configMap.name });
      if (source.secret?.name) add({ kind: "Secret", short: "secret", name: source.secret.name });
    }
  }

  for (const container of containers) {
    for (const envFrom of container.envFrom ?? []) {
      if (envFrom.configMapRef?.name) add({ kind: "ConfigMap", short: "cm", name: envFrom.configMapRef.name });
      if (envFrom.secretRef?.name) add({ kind: "Secret", short: "secret", name: envFrom.secretRef.name });
    }

    for (const env of container.env ?? []) {
      if (env.valueFrom?.configMapKeyRef?.name)
        add({ kind: "ConfigMap", short: "cm", name: env.valueFrom.configMapKeyRef.name });
      if (env.valueFrom?.secretKeyRef?.name)
        add({ kind: "Secret", short: "secret", name: env.valueFrom.secretKeyRef.name });
    }
  }

  if (o.kind === "StatefulSet") {
    const claimTemplates: RawObject[] = o.spec?.volumeClaimTemplates ?? [];

    for (const template of claimTemplates) {
      add({ kind: "PersistentVolumeClaim", short: "pvc", name: `${template.metadata.name}-${o.metadata.name}-*` });
    }
  }

  add({ kind: "ServiceAccount", short: "sa", name: podSpec?.serviceAccountName ?? "default" });

  for (const pdb of input.podDisruptionBudgets) {
    if (nsOf(pdb) === namespace && selectorMatches(pdb.spec?.selector, labels, true)) {
      add({ kind: "PodDisruptionBudget", short: "pdb", name: pdb.metadata.name });
    }
  }

  for (const policy of input.networkPolicies) {
    if (nsOf(policy) === namespace && selectorMatches(policy.spec?.podSelector ?? {}, labels, true)) {
      add({ kind: "NetworkPolicy", short: "np", name: policy.metadata.name });
    }
  }

  return out;
}

// ---------------------------------------------------------------- graph

export function buildTopology(input: TopologyInput, mode: TopologyMode): TopologyGraph {
  const nodes = new Map<string, TopologyNode>();
  const edges = new Map<string, TopologyEdge>();
  const addEdge = (from: string, to: string, type: TopologyEdgeType, via: string, inferred = false) => {
    if (from === to || !nodes.has(from) || !nodes.has(to)) {
      return;
    }

    const id = `${type}:${from}->${to}`;

    if (!edges.has(id)) {
      edges.set(id, { id, from, to, type, via, inferred });
    }
  };
  const node = (o: RawObject, kind: string, column: number, extra: Partial<TopologyNode>): TopologyNode => ({
    id: keyOf(kind, nsOf(o), o.metadata.name),
    kind,
    name: o.metadata.name,
    namespace: nsOf(o),
    group:
      groupLabelOf(o.kind === "Service" || o.kind === "Ingress" ? o.metadata.labels : podTemplateOf(o).labels) ||
      groupLabelOf(o.metadata.labels) ||
      o.metadata.name,
    status: "ok",
    summary: "",
    flags: [],
    pods: [],
    attachments: [],
    outsideView: false,
    selfLink: o.metadata.selfLink,
    column,
    ...extra,
  });

  // Owner chains: Pod -> ReplicaSet -> Deployment, Pod -> Job -> CronJob.
  const byUid = new Map<string, RawObject>();

  for (const o of [
    ...input.deployments,
    ...input.statefulSets,
    ...input.daemonSets,
    ...input.replicaSets,
    ...input.cronJobs,
    ...input.jobs,
  ]) {
    if (o.metadata.uid) {
      byUid.set(o.metadata.uid, o);
    }
  }

  const findOwner = (o: RawObject, kinds: string[]): RawObject | undefined => {
    for (const ref of o.metadata.ownerReferences ?? []) {
      const owner =
        (ref.uid && byUid.get(ref.uid)) ||
        [...byUid.values()].find((c) => c.kind === ref.kind && c.metadata.name === ref.name && nsOf(c) === nsOf(o));

      if (owner) {
        return kinds.includes(owner.kind ?? "") ? owner : findOwner(owner, kinds);
      }
    }

    return undefined;
  };

  const withKind = (list: RawObject[], kind: string) => list.map((o) => ({ ...o, kind: o.kind ?? kind }));
  const workloads = [
    ...withKind(input.deployments, "Deployment"),
    ...withKind(input.statefulSets, "StatefulSet"),
    ...withKind(input.daemonSets, "DaemonSet"),
    ...withKind(input.cronJobs, "CronJob"),
    ...withKind(input.jobs, "Job").filter((job) => !findOwner(job, ["CronJob"])),
  ];
  const pods = withKind(input.pods, "Pod");
  const podsOfWorkload = new Map<string, RawObject[]>();
  const orphanPods: RawObject[] = [];

  for (const pod of pods) {
    const owner = findOwner(pod, [...WORKLOAD_KINDS]);
    const ownerJobParent = owner?.kind === "Job" ? findOwner(owner, ["CronJob"]) : undefined;
    const top = ownerJobParent ?? owner;

    if (top) {
      const key = keyOf(top.kind ?? "", nsOf(top), top.metadata.name);

      podsOfWorkload.set(key, [...(podsOfWorkload.get(key) ?? []), pod]);
    } else if (pod.status?.phase !== "Succeeded") {
      orphanPods.push(pod);
    }
  }

  const configMaps = new Map(input.configMaps.map((cm) => [`${nsOf(cm)}/${cm.metadata.name}`, cm]));
  const services = withKind(input.services, "Service");
  const knownServices = new Set(services.map((s) => `${nsOf(s)}/${s.metadata.name}`));
  const ingresses = withKind(input.ingresses, "Ingress");
  const network = mode === "network";
  const serviceColumn = network ? 2 : 1;
  const hasEntry =
    ingresses.length > 0 || services.some((s) => s.spec?.type === "LoadBalancer" || s.spec?.type === "NodePort");

  // Services
  for (const service of services) {
    const selector = service.spec?.selector;
    const selected = pods.filter(
      (pod) => nsOf(pod) === nsOf(service) && selectorMatches(selector, pod.metadata.labels),
    );
    const ready = selected.filter((pod) => podStatusOf(pod).status === "ok").length;
    const flags: TopologyNode["flags"] = [];
    let status: TopologyStatus = "ok";

    if (service.spec?.type === "LoadBalancer" && !(service.status?.loadBalancer?.ingress ?? []).length) {
      flags.push({ text: "IP pending", detail: "Type LoadBalancer, but no external address has been assigned." });
      status = "warn";
    }

    if (selector && Object.keys(selector).length > 0) {
      if (selected.length === 0) {
        flags.push({ text: "no pods", detail: "The selector matches no pods." });
        status = "err";
      } else if (ready === 0) {
        flags.push({ text: "0 ready", detail: `None of the ${selected.length} selected pods is ready.` });
        status = "err";
      }
    }

    const type = service.spec?.type ?? "ClusterIP";
    const ports = portsOf(service);

    nodes.set(
      keyOf("Service", nsOf(service), service.metadata.name),
      node(service, "Service", serviceColumn, {
        status,
        flags,
        summary: [type === "ClusterIP" && service.spec?.clusterIP === "None" ? "Headless" : type, ports]
          .filter(Boolean)
          .join(" · "),
      }),
    );
  }

  // Workloads (architecture) or pods (network)
  for (const workload of workloads) {
    const id = keyOf(workload.kind ?? "", nsOf(workload), workload.metadata.name);
    const own = podsOfWorkload.get(id) ?? [];
    const podSummaries = own.map(podStatusOf).sort((a, b) => a.name.localeCompare(b.name));
    const template = podTemplateOf(workload);
    const { status, summary } = workloadReadiness(workload, podSummaries);

    if (!network) {
      nodes.set(
        id,
        node(workload, workload.kind ?? "", 2, {
          status,
          summary,
          pods: podSummaries,
          attachments: attachmentsOf(workload, template.spec, template.labels, input),
        }),
      );
    }
  }

  if (network) {
    for (const pod of pods.filter((p) => p.status?.phase !== "Succeeded")) {
      const s = podStatusOf(pod);

      nodes.set(
        keyOf("Pod", nsOf(pod), pod.metadata.name),
        node(pod, "Pod", 3, { status: s.status, summary: s.reason, pods: [s] }),
      );
    }
  } else {
    for (const pod of orphanPods) {
      const s = podStatusOf(pod);

      nodes.set(
        keyOf("Pod", nsOf(pod), pod.metadata.name),
        node(pod, "Pod", 2, {
          status: s.status,
          summary: s.reason,
          pods: [s],
          attachments: attachmentsOf(pod, pod.spec, pod.metadata.labels ?? {}, input),
        }),
      );
    }
  }

  // Ingresses route to Services
  for (const ingress of ingresses) {
    const id = keyOf("Ingress", nsOf(ingress), ingress.metadata.name);
    const hosts: string[] = (ingress.spec?.rules ?? []).map((r: { host?: string }) => r.host).filter(Boolean);
    const lbs = ingress.status?.loadBalancer?.ingress ?? [];

    nodes.set(
      id,
      node(ingress, "Ingress", network ? 1 : 0, {
        summary: hosts.length ? (hosts.length > 1 ? `${hosts[0]} +${hosts.length - 1}` : hosts[0]) : "all hosts",
        status: lbs.length ? "ok" : "warn",
        flags: lbs.length ? [] : [{ text: "no address", detail: "No ingress controller has assigned an address yet." }],
      }),
    );

    const backends: {
      service?: { name?: string; port?: { number?: number; name?: string } };
      serviceName?: string;
      servicePort?: string | number;
    }[] = [
      ingress.spec?.defaultBackend ?? ingress.spec?.backend,
      ...(ingress.spec?.rules ?? []).flatMap((r: { http?: { paths?: { backend?: object }[] } }) =>
        (r.http?.paths ?? []).map((p) => p.backend),
      ),
    ].filter(Boolean);

    for (const backend of backends) {
      const name = backend.service?.name ?? backend.serviceName;
      const port = backend.service?.port?.number ?? backend.service?.port?.name ?? backend.servicePort;

      if (name) {
        addEdge(id, keyOf("Service", nsOf(ingress), name), "routes", port ? `port ${port}` : "backend");
      }
    }
  }

  // Outside world, for the network view
  if (network && hasEntry) {
    nodes.set(OUTSIDE, {
      id: OUTSIDE,
      kind: "External",
      name: "Outside the cluster",
      namespace: "",
      group: "",
      status: "ok",
      summary: "",
      flags: [],
      pods: [],
      attachments: [],
      outsideView: false,
      column: 0,
    });

    for (const ingress of ingresses) {
      addEdge(OUTSIDE, keyOf("Ingress", nsOf(ingress), ingress.metadata.name), "routes", "HTTP");
    }

    for (const service of services.filter((s) => s.spec?.type === "LoadBalancer" || s.spec?.type === "NodePort")) {
      addEdge(
        OUTSIDE,
        keyOf("Service", nsOf(service), service.metadata.name),
        "routes",
        `${service.spec.type} ${portsOf(service)}`.trim(),
      );
    }

    if (
      nodes.get(OUTSIDE) &&
      services.some((s) => s.spec?.type === "LoadBalancer" && !(s.status?.loadBalancer?.ingress ?? []).length) &&
      ingresses.length === 0
    ) {
      const outside = nodes.get(OUTSIDE);

      if (outside) {
        outside.status = "warn";
        outside.flags = [{ text: "no address", detail: "No LoadBalancer Service has an external address yet." }];
      }
    }
  }

  // Services expose workloads (architecture) or pods (network)
  for (const service of services) {
    const serviceId = keyOf("Service", nsOf(service), service.metadata.name);
    const selector = service.spec?.selector;
    const port = portsOf(service);

    if (!selector || Object.keys(selector).length === 0) {
      continue;
    }

    if (network) {
      for (const pod of pods) {
        if (nsOf(pod) === nsOf(service) && selectorMatches(selector, pod.metadata.labels)) {
          addEdge(
            serviceId,
            keyOf("Pod", nsOf(pod), pod.metadata.name),
            "exposes",
            port ? `selector · ${port}` : "selector",
          );
        }
      }
    } else {
      for (const workload of workloads) {
        if (nsOf(workload) === nsOf(service) && selectorMatches(selector, podTemplateOf(workload).labels)) {
          addEdge(
            serviceId,
            keyOf(workload.kind ?? "", nsOf(workload), workload.metadata.name),
            "exposes",
            port ? `selector · ${port}` : "selector",
          );
        }
      }

      for (const pod of orphanPods) {
        if (nsOf(pod) === nsOf(service) && selectorMatches(selector, pod.metadata.labels)) {
          addEdge(serviceId, keyOf("Pod", nsOf(pod), pod.metadata.name), "exposes", "selector");
        }
      }
    }
  }

  // Calls inferred from configuration
  const callers: { id: string; namespace: string; spec: unknown; selfServices: Set<string> }[] = [];
  const servicesSelecting = (namespace: string, labels: Record<string, string>) =>
    new Set(
      services
        .filter((s) => nsOf(s) === namespace && selectorMatches(s.spec?.selector, labels))
        .map((s) => s.metadata.name),
    );

  if (network) {
    for (const pod of pods) {
      callers.push({
        id: keyOf("Pod", nsOf(pod), pod.metadata.name),
        namespace: nsOf(pod),
        spec: pod.spec,
        selfServices: servicesSelecting(nsOf(pod), pod.metadata.labels ?? {}),
      });
    }
  } else {
    for (const workload of [...workloads, ...orphanPods]) {
      const template = podTemplateOf(workload);

      callers.push({
        id: keyOf(workload.kind ?? "Pod", nsOf(workload), workload.metadata.name),
        namespace: nsOf(workload),
        spec: template.spec,
        selfServices: servicesSelecting(nsOf(workload), template.labels),
      });
    }
  }

  for (const caller of callers) {
    for (const source of configSourcesOf(caller.spec, caller.namespace, configMaps)) {
      for (const ref of findServiceReferences(source.text, caller.namespace, knownServices)) {
        if (ref.namespace === caller.namespace && caller.selfServices.has(ref.service)) {
          continue; // a workload naming its own Service is not a dependency
        }

        const targetId = keyOf("Service", ref.namespace, ref.service);

        if (!nodes.has(targetId)) {
          nodes.set(targetId, {
            id: targetId,
            kind: "Service",
            name: ref.service,
            namespace: ref.namespace,
            group: ref.namespace,
            status: "ok",
            summary: `namespace ${ref.namespace}`,
            flags: [],
            pods: [],
            attachments: [],
            outsideView: true,
            column: serviceColumn,
          });
        }

        addEdge(caller.id, targetId, "calls", `${ref.port ? `:${ref.port} · ` : ""}${source.via}`, true);
      }
    }
  }

  const total =
    input.ingresses.length +
    input.services.length +
    input.deployments.length +
    input.statefulSets.length +
    input.daemonSets.length +
    input.replicaSets.length +
    input.cronJobs.length +
    input.jobs.length +
    input.pods.length +
    input.configMaps.length +
    input.persistentVolumeClaims.length +
    input.podDisruptionBudgets.length +
    input.networkPolicies.length;

  return { nodes: [...nodes.values()], edges: [...edges.values()], hiddenCount: Math.max(0, total - nodes.size) };
}

// ---------------------------------------------------------------- path

/** Everything reachable from `start` along edges, plus everything that reaches it. */
export function pathOf(edges: TopologyEdge[], start: string | undefined): { nodes: Set<string>; edges: Set<string> } {
  const nodeSet = new Set<string>();
  const edgeSet = new Set<string>();

  if (!start) {
    return { nodes: nodeSet, edges: edgeSet };
  }

  nodeSet.add(start);

  for (const direction of ["down", "up"] as const) {
    const seen = new Set([start]);
    const stack = [start];

    while (stack.length) {
      const current = stack.pop() as string;

      for (const edge of edges) {
        const [from, to] = direction === "down" ? [edge.from, edge.to] : [edge.to, edge.from];

        if (from === current) {
          edgeSet.add(edge.id);

          if (!seen.has(to)) {
            seen.add(to);
            nodeSet.add(to);
            stack.push(to);
          }
        }
      }
    }
  }

  return { nodes: nodeSet, edges: edgeSet };
}

// ---------------------------------------------------------------- layout

export interface LaidOutNode extends TopologyNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaidOutGroup {
  id: string;
  label: string;
  meta: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TopologyLayout {
  nodes: LaidOutNode[];
  groups: LaidOutGroup[];
  width: number;
  height: number;
}

const NODE_SIZE: Record<string, [number, number]> = {
  External: [160, 72],
  Ingress: [220, 74],
  Service: [220, 74],
  Pod: [220, 56],
};
const WORKLOAD_SIZE: [number, number] = [256, 96];
const GROUP_PAD = { top: 52, side: 20, bottom: 20 };
const COLUMN_GAP = 64;
const ROW_GAP = 14;
const GROUP_GAP_X = 96;
const GROUP_GAP_Y = 32;
// Groups that don't call each other would otherwise stack into one very tall column.
const MAX_COLUMN_HEIGHT = 1400;

const sizeOf = (n: TopologyNode): [number, number] => NODE_SIZE[n.kind] ?? WORKLOAD_SIZE;

/**
 * Layered layout: groups (by app label) are placed in columns by how they call each other,
 * left to right; inside a group, nodes are placed in columns by kind and ordered to follow
 * their neighbours (one barycentre pass), which keeps most edges short and uncrossed.
 */
export function layoutTopology(graph: TopologyGraph): TopologyLayout {
  const groupIds = [...new Set(graph.nodes.filter((n) => n.kind !== "External").map((n) => n.group))].sort();
  const groupOf = new Map(graph.nodes.map((n) => [n.id, n.group]));

  // Group depth from cross-group edges (longest path, cycles broken by visit order).
  const depth = new Map(groupIds.map((g) => [g, 0]));

  for (let pass = 0; pass < groupIds.length; pass++) {
    let changed = false;

    for (const edge of graph.edges) {
      const from = groupOf.get(edge.from);
      const to = groupOf.get(edge.to);

      if (
        from &&
        to &&
        from !== to &&
        from !== "" &&
        to !== "" &&
        (depth.get(to) ?? 0) < (depth.get(from) ?? 0) + 1 &&
        (depth.get(from) ?? 0) + 1 < groupIds.length
      ) {
        depth.set(to, (depth.get(from) ?? 0) + 1);
        changed = true;
      }
    }

    if (!changed) {
      break;
    }
  }

  const position = new Map<string, number>();
  const laidNodes: LaidOutNode[] = [];
  const laidGroups: LaidOutGroup[] = [];
  const outside = graph.nodes.find((n) => n.kind === "External");
  const startX = outside ? 24 + sizeOf(outside)[0] + GROUP_GAP_X : 24;
  const maxDepth = Math.max(0, ...depth.values());
  let x = startX;
  let totalHeight = 0;

  for (let d = 0; d <= maxDepth; d++) {
    const inColumn = groupIds.filter((g) => depth.get(g) === d);
    let y = 24;
    let columnWidth = 0;

    for (const groupId of inColumn) {
      const members = graph.nodes.filter((n) => n.group === groupId && n.kind !== "External");
      const columns = [...new Set(members.map((n) => n.column))].sort((a, b) => a - b);
      let innerX = x + GROUP_PAD.side;
      let groupHeight = 0;

      const columnHeights = columns.map((column) => {
        const inCol = members.filter((n) => n.column === column);

        return inCol.reduce((sum, n) => sum + sizeOf(n)[1], 0) + ROW_GAP * (inCol.length - 1);
      });
      const contentHeight = Math.max(0, ...columnHeights);

      if (y > 24 && y + GROUP_PAD.top + contentHeight + GROUP_PAD.bottom > MAX_COLUMN_HEIGHT) {
        totalHeight = Math.max(totalHeight, y);
        x += columnWidth + GROUP_GAP_X;
        y = 24;
        columnWidth = 0;
        innerX = x + GROUP_PAD.side;
      }

      columns.forEach((column, index) => {
        const inCol = members.filter((n) => n.column === column);
        const neighbourAverage = (n: TopologyNode) => {
          const ys = graph.edges
            .filter((e) => (e.to === n.id && position.has(e.from)) || (e.from === n.id && position.has(e.to)))
            .map((e) => position.get(e.to === n.id ? e.from : e.to) as number);

          return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Number.POSITIVE_INFINITY;
        };

        inCol.sort((a, b) => neighbourAverage(a) - neighbourAverage(b) || a.name.localeCompare(b.name));

        const width = Math.max(...inCol.map((n) => sizeOf(n)[0]));
        let rowY = y + GROUP_PAD.top + (contentHeight - columnHeights[index]) / 2;

        for (const n of inCol) {
          const [w, h] = sizeOf(n);

          laidNodes.push({ ...n, x: innerX, y: Math.round(rowY), width: w, height: h });
          position.set(n.id, rowY + h / 2);
          rowY += h + ROW_GAP;
        }

        innerX += width + COLUMN_GAP;
      });

      const groupWidth = innerX - COLUMN_GAP + GROUP_PAD.side - x;

      groupHeight = GROUP_PAD.top + contentHeight + GROUP_PAD.bottom;

      const kinds = members.reduce<Record<string, number>>(
        (acc, n) => ({ ...acc, [n.kind]: (acc[n.kind] ?? 0) + 1 }),
        {},
      );

      laidGroups.push({
        id: groupId,
        label: groupId,
        meta: Object.entries(kinds)
          .map(([kind, count]) => `${count} ${kind}${count > 1 ? "s" : ""}`)
          .join(" · "),
        x,
        y,
        width: groupWidth,
        height: groupHeight,
      });
      y += groupHeight + GROUP_GAP_Y;
      columnWidth = Math.max(columnWidth, groupWidth);
    }

    totalHeight = Math.max(totalHeight, y);
    x += columnWidth + GROUP_GAP_X;
  }

  if (outside) {
    const [w, h] = sizeOf(outside);
    const targets = laidNodes.filter((n) => graph.edges.some((e) => e.from === outside.id && e.to === n.id));
    const centre = targets.length ? targets.reduce((sum, n) => sum + n.y + n.height / 2, 0) / targets.length : 120;

    laidNodes.push({ ...outside, x: 24, y: Math.round(centre - h / 2), width: w, height: h });
  }

  return {
    nodes: laidNodes,
    groups: laidGroups,
    width: Math.max(x - GROUP_GAP_X + 24, 600),
    height: Math.max(totalHeight, 400),
  };
}
