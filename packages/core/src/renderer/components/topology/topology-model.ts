/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Builds the Topology graph from plain Kubernetes manifests. Pure: no stores, no DI,
// so every rule here is unit-tested with fixtures.
//
// The graph is always built for every namespace, because a link into or out of a
// namespace is only visible with both ends loaded. A view then picks from it:
// - "overview": one card per namespace, with the links between namespaces.
// - "architecture": the selected namespaces, Gateway / VirtualService / Ingress ->
//   Service -> workload, with pods and config folded into the workload card.
// - "network": the selected namespaces, outside -> load balancer -> Gateway ->
//   VirtualService / Ingress -> Service -> each pod.
// Both detailed views keep the other end of every link that leaves the selection, and
// the whole chain of routes that brings traffic in, drawn as cards outside the view.
// "calls" edges are inferred from configuration: a Service's DNS name or URL found in a
// workload's env values, args or the ConfigMaps it reads.

export type TopologyMode = "overview" | "architecture" | "network";
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
  /** Istio networking.istio.io Gateways, when Istio is installed */
  gateways?: RawObject[];
  /** Istio networking.istio.io VirtualServices, when Istio is installed */
  virtualServices?: RawObject[];
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

export interface TopologyFlag {
  text: string;
  detail: string;
}

export interface TopologyNode {
  id: string;
  kind: string;
  name: string;
  namespace: string;
  /** Unique across namespaces: `${namespace}/${label}`, or `ns:${namespace}` for cards outside the view */
  group: string;
  groupLabel: string;
  status: TopologyStatus;
  summary: string;
  flags: TopologyFlag[];
  pods: TopologyPodSummary[];
  attachments: TopologyAttachment[];
  /** Host names this node receives traffic for (Ingress, Gateway, VirtualService) */
  hosts: string[];
  outsideView: boolean;
  selfLink?: string;
  column: number;
  /** For a pod in the network view: the workload card that stands for it outside the view */
  collapseTo?: string;
}

export interface TopologyEdge {
  id: string;
  from: string;
  to: string;
  type: TopologyEdgeType;
  /** Short text drawn on the line, e.g. "calls :2181" */
  label: string;
  /** Where the edge comes from, for the details panel */
  via: string;
  inferred: boolean;
  /** How many links this edge stands for, in the overview */
  count: number;
}

export interface TopologyGraph {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  hiddenCount: number;
  /** Workload cards that pods collapse into when they are outside the view (network view only) */
  collapsed: TopologyNode[];
  /** How many objects each namespace has, to say how many were folded into cards */
  objectCounts: Record<string, number>;
}

export const OUTSIDE = "outside";

const WORKLOAD_KINDS = ["Deployment", "StatefulSet", "DaemonSet", "CronJob", "Job"] as const;
const COLUMN: Record<string, number> = { Gateway: 0, VirtualService: 1, Ingress: 1, Service: 2 };
const WORKLOAD_COLUMN = 3;

// ---------------------------------------------------------------- helpers

const keyOf = (kind: string, namespace: string, name: string) => `${kind.toLowerCase()}/${namespace}/${name}`;
const nsOf = (o: RawObject) => o.metadata.namespace ?? "";
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const listSummary = (items: string[], empty = "") =>
  items.length === 0 ? empty : items.length === 1 ? items[0] : `${items[0]} +${items.length - 1}`;

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

/** Addresses given by the load balancer, or set by hand in spec.externalIPs (kubectl shows both). */
function externalAddressOf(service: RawObject): string {
  const ingress: { ip?: string; hostname?: string }[] = service.status?.loadBalancer?.ingress ?? [];
  const externalIPs: string[] = service.spec?.externalIPs ?? [];

  return listSummary([...new Set([...ingress.map((i) => i.ip ?? i.hostname ?? ""), ...externalIPs])].filter(Boolean));
}

const worst = (statuses: TopologyStatus[]): TopologyStatus =>
  statuses.includes("err") ? "err" : statuses.includes("warn") ? "warn" : "ok";

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

export type ReferenceFinder = (text: string, ownNamespace: string, knownServices: Set<string>) => CallReference[];

/**
 * findServiceReferences, remembering its answers. The graph is rebuilt on every change in the
 * cluster, but configuration rarely changes, so most texts (some ConfigMaps are megabytes) are
 * only scanned once. The memory is dropped whenever the set of Services changes.
 */
export function createReferenceFinder(maxEntries = 20_000): ReferenceFinder {
  let servicesKey = "";
  let memory = new Map<string, CallReference[]>();

  return (text, ownNamespace, knownServices) => {
    const key = `${knownServices.size}:${[...knownServices].join(",")}`;

    if (key !== servicesKey || memory.size > maxEntries) {
      servicesKey = key;
      memory = new Map();
    }

    const textKey = `${ownNamespace}\u0000${text}`;
    let refs = memory.get(textKey);

    if (!refs) {
      refs = findServiceReferences(text, ownNamespace, knownServices);
      memory.set(textKey, refs);
    }

    return refs;
  };
}

interface ConfigSource {
  text: string;
  via: string;
}

/**
 * Grafana dashboards are full of example host names (Istio's name bookinfo's Services), and
 * Grafana doesn't call what its dashboards mention.
 */
function isDashboard(configMap: RawObject): boolean {
  const labels = configMap.metadata.labels ?? {};

  return "grafana_dashboard" in labels || /dashboard/i.test(configMap.metadata.name);
}

/** The API server, which everything that talks to Kubernetes names: not an app dependency. */
const isApiServer = (ref: CallReference) => ref.namespace === "default" && ref.service === "kubernetes";

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

    if (!configMap || isDashboard(configMap)) {
      continue;
    }

    for (const [key, value] of Object.entries(configMap.data ?? {})) {
      sources.push({ text: value, via: `${key} in ConfigMap ${name}` });
    }
  }

  return sources;
}

function attachmentsOf(
  o: RawObject,
  podSpec: any,
  labels: Record<string, string>,
  pdbs: RawObject[],
  policies: RawObject[],
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

  for (const pdb of pdbs) {
    if (nsOf(pdb) === namespace && selectorMatches(pdb.spec?.selector, labels, true)) {
      add({ kind: "PodDisruptionBudget", short: "pdb", name: pdb.metadata.name });
    }
  }

  for (const policy of policies) {
    if (nsOf(policy) === namespace && selectorMatches(policy.spec?.podSelector ?? {}, labels, true)) {
      add({ kind: "NetworkPolicy", short: "np", name: policy.metadata.name });
    }
  }

  return out;
}

/**
 * Where an Istio destination host points: `name` (the VirtualService's namespace), `name.ns`,
 * or `name.ns.svc[.cluster.local]`. Anything else is a host outside the cluster.
 */
export function resolveServiceHost(
  host: string,
  ownNamespace: string,
  knownServices: Set<string>,
): { namespace: string; service: string } | undefined {
  const parts = host.toLowerCase().split(".");
  const svcIndex = parts.indexOf("svc");

  if (svcIndex === 2) {
    return { namespace: parts[1], service: parts[0] };
  }

  if (parts.length === 1) {
    return { namespace: ownNamespace, service: parts[0] };
  }

  if (parts.length === 2 && knownServices.has(`${parts[1]}/${parts[0]}`)) {
    return { namespace: parts[1], service: parts[0] };
  }

  return undefined;
}

// ---------------------------------------------------------------- graph

export interface BuildOptions {
  findReferences?: ReferenceFinder;
}

export function buildTopology(
  input: TopologyInput,
  mode: "architecture" | "network",
  { findReferences = findServiceReferences }: BuildOptions = {},
): TopologyGraph {
  const nodes = new Map<string, TopologyNode>();
  const edges = new Map<string, TopologyEdge>();
  const collapsed = new Map<string, TopologyNode>();
  const addEdge = (from: string, to: string, type: TopologyEdgeType, label: string, via: string, inferred = false) => {
    if (from === to || !nodes.has(from) || !nodes.has(to)) {
      return;
    }

    const id = `${type}:${from}->${to}`;

    if (!edges.has(id)) {
      edges.set(id, { id, from, to, type, label, via, inferred, count: 1 });
    }
  };
  const node = (
    o: RawObject,
    kind: string,
    column: number,
    extra: Partial<TopologyNode> & { label?: string },
  ): TopologyNode => {
    const { label: givenLabel, ...rest } = extra;
    const label =
      givenLabel ??
      (groupLabelOf(o.kind === "Service" || o.kind === "Ingress" ? o.metadata.labels : podTemplateOf(o).labels) ||
        groupLabelOf(o.metadata.labels) ||
        o.metadata.name);

    return {
      id: keyOf(kind, nsOf(o), o.metadata.name),
      kind,
      name: o.metadata.name,
      namespace: nsOf(o),
      group: `${nsOf(o)}/${label}`,
      groupLabel: label,
      status: "ok",
      summary: "",
      flags: [],
      pods: [],
      attachments: [],
      hosts: [],
      outsideView: false,
      selfLink: o.metadata.selfLink,
      column,
      ...rest,
    };
  };

  // Owner chains: Pod -> ReplicaSet -> Deployment, Pod -> Job -> CronJob.
  const byUid = new Map<string, RawObject>();
  const byName = new Map<string, RawObject>();

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

    byName.set(`${o.kind}/${nsOf(o)}/${o.metadata.name}`, o);
  }

  const findOwner = (o: RawObject, kinds: string[], depth = 0): RawObject | undefined => {
    for (const ref of o.metadata.ownerReferences ?? []) {
      const owner = (ref.uid && byUid.get(ref.uid)) || byName.get(`${ref.kind}/${nsOf(o)}/${ref.name}`);

      if (owner) {
        return kinds.includes(owner.kind ?? "") ? owner : depth < 3 ? findOwner(owner, kinds, depth + 1) : undefined;
      }
    }

    return undefined;
  };

  const withKind = (list: RawObject[], kind: string) => list.map((o) => (o.kind ? o : { ...o, kind }));
  const workloads = [
    ...withKind(input.deployments, "Deployment"),
    ...withKind(input.statefulSets, "StatefulSet"),
    ...withKind(input.daemonSets, "DaemonSet"),
    ...withKind(input.cronJobs, "CronJob"),
    ...withKind(input.jobs, "Job").filter((job) => !findOwner(job, ["CronJob"])),
  ];
  const pods = withKind(input.pods, "Pod");
  const podsOfWorkload = new Map<string, RawObject[]>();
  const workloadOfPod = new Map<RawObject, string>();
  const orphanPods: RawObject[] = [];

  for (const pod of pods) {
    const owner = findOwner(pod, [...WORKLOAD_KINDS]);
    const ownerJobParent = owner?.kind === "Job" ? findOwner(owner, ["CronJob"]) : undefined;
    const top = ownerJobParent ?? owner;

    if (top) {
      const key = keyOf(top.kind ?? "", nsOf(top), top.metadata.name);

      podsOfWorkload.set(key, [...(podsOfWorkload.get(key) ?? []), pod]);
      workloadOfPod.set(pod, key);
    } else if (pod.status?.phase !== "Succeeded") {
      orphanPods.push(pod);
    }
  }

  const podsByNamespace = new Map<string, RawObject[]>();

  for (const pod of pods) {
    podsByNamespace.set(nsOf(pod), [...(podsByNamespace.get(nsOf(pod)) ?? []), pod]);
  }

  const configMaps = new Map(input.configMaps.map((cm) => [`${nsOf(cm)}/${cm.metadata.name}`, cm]));
  const services = withKind(input.services, "Service");
  const knownServices = new Set(services.map((s) => `${nsOf(s)}/${s.metadata.name}`));
  const ingresses = withKind(input.ingresses, "Ingress");
  const gateways = withKind(input.gateways ?? [], "Gateway");
  const virtualServices = withKind(input.virtualServices ?? [], "VirtualService");
  const network = mode === "network";
  const isEntryService = (s: RawObject) => s.spec?.type === "LoadBalancer" || s.spec?.type === "NodePort";
  const selectedBy = (service: RawObject) =>
    (podsByNamespace.get(nsOf(service)) ?? []).filter((pod) =>
      selectorMatches(service.spec?.selector, pod.metadata.labels),
    );

  // Services
  for (const service of services) {
    const selector = service.spec?.selector;
    const selected = selectedBy(service);
    const ready = selected.filter((pod) => podStatusOf(pod).status === "ok").length;
    const flags: TopologyFlag[] = [];
    let status: TopologyStatus = "ok";

    if (service.spec?.type === "LoadBalancer" && !externalAddressOf(service)) {
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
      node(service, "Service", COLUMN.Service, {
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
    const card = node(workload, workload.kind ?? "", WORKLOAD_COLUMN, {
      status,
      summary,
      pods: podSummaries,
      attachments: attachmentsOf(
        workload,
        template.spec,
        template.labels,
        input.podDisruptionBudgets,
        input.networkPolicies,
      ),
    });

    (network ? collapsed : nodes).set(id, card);
  }

  if (network) {
    for (const pod of pods.filter((p) => p.status?.phase !== "Succeeded")) {
      const s = podStatusOf(pod);

      nodes.set(
        keyOf("Pod", nsOf(pod), pod.metadata.name),
        node(pod, "Pod", WORKLOAD_COLUMN, {
          status: s.status,
          summary: s.reason,
          pods: [s],
          collapseTo: workloadOfPod.get(pod),
        }),
      );
    }
  } else {
    for (const pod of orphanPods) {
      const s = podStatusOf(pod);

      nodes.set(
        keyOf("Pod", nsOf(pod), pod.metadata.name),
        node(pod, "Pod", WORKLOAD_COLUMN, {
          status: s.status,
          summary: s.reason,
          pods: [s],
          attachments: attachmentsOf(
            pod,
            pod.spec,
            pod.metadata.labels ?? {},
            input.podDisruptionBudgets,
            input.networkPolicies,
          ),
        }),
      );
    }
  }

  // Routing objects sit in the box of the app they send traffic to, when it's in their namespace.
  const groupOfService = (namespace: string, name: string) => nodes.get(keyOf("Service", namespace, name))?.groupLabel;

  // Istio Gateways: which load balancer Service fronts them, and which hosts they accept.
  for (const gateway of gateways) {
    const id = keyOf("Gateway", nsOf(gateway), gateway.metadata.name);
    const servers: { hosts?: string[]; port?: { number?: number; protocol?: string } }[] = gateway.spec?.servers ?? [];
    const hosts = [...new Set(servers.flatMap((s) => s.hosts ?? []))];
    const ports = [...new Set(servers.map((s) => s.port?.number).filter(Boolean))];
    const selector: Record<string, string> = gateway.spec?.selector ?? {};

    nodes.set(
      id,
      node(gateway, "Gateway", COLUMN.Gateway, {
        label: "routing",
        summary: [listSummary(hosts, "all hosts"), ports.map((p) => `:${p}`).join(" ")].filter(Boolean).join(" · "),
        hosts,
      }),
    );

    if (Object.keys(selector).length === 0) {
      continue;
    }

    // The gateway selector picks the ingress gateway pods (any namespace); the Services that select
    // those pods are where the traffic comes in. Without pods (no access), compare the selectors.
    const gatewayPods = pods.filter((pod) => selectorMatches(selector, pod.metadata.labels));
    const fronting = services.filter((service) =>
      gatewayPods.length > 0
        ? gatewayPods.some(
            (pod) => nsOf(pod) === nsOf(service) && selectorMatches(service.spec?.selector, pod.metadata.labels),
          )
        : Object.entries(selector).every(([key, value]) => service.spec?.selector?.[key] === value),
    );

    for (const service of fronting) {
      addEdge(
        keyOf("Service", nsOf(service), service.metadata.name),
        id,
        "routes",
        `routes ${ports.map((p) => `:${p}`).join(" ")}`.trim(),
        `gateway selector ${Object.entries(selector)
          .map(([key, value]) => `${key}=${value}`)
          .join(", ")}`,
      );
    }
  }

  // Istio VirtualServices: Gateway -> VirtualService -> destination Service.
  for (const virtualService of virtualServices) {
    const namespace = nsOf(virtualService);
    const id = keyOf("VirtualService", namespace, virtualService.metadata.name);
    const hosts: string[] = virtualService.spec?.hosts ?? [];
    const gatewayRefs: string[] = virtualService.spec?.gateways ?? [];
    const flags: TopologyFlag[] = [];
    const destinations: { host: string; port?: number }[] = [
      ...(virtualService.spec?.http ?? []),
      ...(virtualService.spec?.tcp ?? []),
      ...(virtualService.spec?.tls ?? []),
    ]
      .flatMap(
        (route: { route?: { destination?: { host?: string; port?: { number?: number } } }[] }) => route.route ?? [],
      )
      .map((route) => route.destination)
      .filter((d): d is { host: string; port?: { number?: number } } => Boolean(d?.host))
      .map((d) => ({ host: d.host, port: d.port?.number }));
    const resolved = destinations.map((d) => ({ ...d, target: resolveServiceHost(d.host, namespace, knownServices) }));
    const sameNamespaceTarget = resolved.find((d) => d.target?.namespace === namespace)?.target;

    nodes.set(
      id,
      node(virtualService, "VirtualService", COLUMN.VirtualService, {
        label: (sameNamespaceTarget && groupOfService(namespace, sameNamespaceTarget.service)) || "routing",
        summary: [listSummary(hosts), gatewayRefs.length === 0 || gatewayRefs.includes("mesh") ? "mesh" : ""]
          .filter(Boolean)
          .join(" · "),
        hosts,
      }),
    );

    for (const ref of gatewayRefs) {
      if (ref === "mesh") {
        continue;
      }

      const [gatewayNamespace, gatewayName] = ref.includes("/") ? ref.split("/") : [namespace, ref];
      const gatewayId = keyOf("Gateway", gatewayNamespace, gatewayName);

      if (nodes.has(gatewayId)) {
        addEdge(gatewayId, id, "routes", `routes ${listSummary(hosts)}`.trim(), `hosts ${hosts.join(", ")}`);
      } else {
        flags.push({
          text: "gateway missing",
          detail: `Gateway ${gatewayNamespace}/${gatewayName} does not exist, so this route gets no traffic through it.`,
        });
      }
    }

    for (const { host, port, target } of resolved) {
      const serviceId = target && keyOf("Service", target.namespace, target.service);

      if (serviceId && nodes.has(serviceId)) {
        addEdge(
          id,
          serviceId,
          "routes",
          port ? `routes :${port}` : "routes",
          `destination ${host}${port ? `:${port}` : ""}`,
        );
      } else if (target) {
        flags.push({ text: "no such Service", detail: `The destination ${host} matches no Service.` });
      }
    }

    const vsNode = nodes.get(id);

    if (vsNode && flags.length > 0) {
      vsNode.flags = flags;
      vsNode.status = "err";
    }
  }

  // Ingresses route to Services
  for (const ingress of ingresses) {
    const id = keyOf("Ingress", nsOf(ingress), ingress.metadata.name);
    const hosts: string[] = (ingress.spec?.rules ?? []).map((r: { host?: string }) => r.host).filter(Boolean);
    const lbs = ingress.status?.loadBalancer?.ingress ?? [];
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
    const firstBackend = backends.map((b) => b.service?.name ?? b.serviceName).find(Boolean);

    nodes.set(
      id,
      node(ingress, "Ingress", COLUMN.Ingress, {
        label:
          groupLabelOf(ingress.metadata.labels) ||
          (firstBackend && groupOfService(nsOf(ingress), firstBackend)) ||
          ingress.metadata.name,
        summary: listSummary(hosts, "all hosts"),
        hosts,
        status: lbs.length ? "ok" : "warn",
        flags: lbs.length ? [] : [{ text: "no address", detail: "No ingress controller has assigned an address yet." }],
      }),
    );

    for (const backend of backends) {
      const name = backend.service?.name ?? backend.serviceName;
      const port = backend.service?.port?.number ?? backend.service?.port?.name ?? backend.servicePort;

      if (name) {
        addEdge(
          id,
          keyOf("Service", nsOf(ingress), name),
          "routes",
          port ? `routes :${port}` : "routes",
          port ? `port ${port}` : "backend",
        );
      }
    }
  }

  // Outside world, for the network view
  const entryServices = services.filter(isEntryService);

  if (network && (ingresses.length > 0 || entryServices.length > 0)) {
    nodes.set(OUTSIDE, {
      id: OUTSIDE,
      kind: "External",
      name: "Outside the cluster",
      namespace: "",
      group: "",
      groupLabel: "",
      status: "ok",
      summary: "",
      flags: [],
      pods: [],
      attachments: [],
      hosts: [],
      outsideView: false,
      column: 0,
    });

    for (const ingress of ingresses) {
      const hosts: string[] = (ingress.spec?.rules ?? []).map((r: { host?: string }) => r.host).filter(Boolean);

      addEdge(
        OUTSIDE,
        keyOf("Ingress", nsOf(ingress), ingress.metadata.name),
        "routes",
        `HTTP ${listSummary(hosts)}`.trim(),
        "HTTP",
      );
    }

    for (const service of entryServices) {
      const address = externalAddressOf(service);

      addEdge(
        OUTSIDE,
        keyOf("Service", nsOf(service), service.metadata.name),
        "routes",
        address || `${service.spec.type} :${portsOf(service)}`,
        `${service.spec.type} ${portsOf(service)}${address ? ` at ${address}` : ""}`.trim(),
      );
    }

    if (
      ingresses.length === 0 &&
      entryServices.every((s) => s.spec?.type === "LoadBalancer" && !externalAddressOf(s))
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
    const label = port ? `exposes :${port}` : "exposes";

    if (!selector || Object.keys(selector).length === 0) {
      continue;
    }

    if (network) {
      for (const pod of selectedBy(service)) {
        addEdge(serviceId, keyOf("Pod", nsOf(pod), pod.metadata.name), "exposes", label, `selector · ${port}`);
      }
    } else {
      for (const workload of workloads) {
        if (nsOf(workload) === nsOf(service) && selectorMatches(selector, podTemplateOf(workload).labels)) {
          addEdge(
            serviceId,
            keyOf(workload.kind ?? "", nsOf(workload), workload.metadata.name),
            "exposes",
            label,
            port ? `selector · ${port}` : "selector",
          );
        }
      }

      for (const pod of orphanPods) {
        if (nsOf(pod) === nsOf(service) && selectorMatches(selector, pod.metadata.labels)) {
          addEdge(serviceId, keyOf("Pod", nsOf(pod), pod.metadata.name), "exposes", label, "selector");
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

  for (const caller of network ? pods.filter((p) => p.status?.phase !== "Succeeded") : [...workloads, ...orphanPods]) {
    const template = podTemplateOf(caller);

    callers.push({
      id: keyOf(caller.kind ?? "Pod", nsOf(caller), caller.metadata.name),
      namespace: nsOf(caller),
      spec: template.spec,
      selfServices: servicesSelecting(nsOf(caller), template.labels),
    });
  }

  for (const caller of callers) {
    for (const source of configSourcesOf(caller.spec, caller.namespace, configMaps)) {
      for (const ref of findReferences(source.text, caller.namespace, knownServices)) {
        if ((ref.namespace === caller.namespace && caller.selfServices.has(ref.service)) || isApiServer(ref)) {
          continue; // a workload naming its own Service, or the API server, is not a dependency
        }

        const targetId = keyOf("Service", ref.namespace, ref.service);

        if (!nodes.has(targetId)) {
          // Named by its full DNS name, but not among the Services we can see.
          nodes.set(targetId, {
            id: targetId,
            kind: "Service",
            name: ref.service,
            namespace: ref.namespace,
            group: `ns:${ref.namespace}`,
            groupLabel: ref.namespace,
            status: "warn",
            summary: `namespace ${ref.namespace}`,
            flags: [
              {
                text: "not found",
                detail: `Configuration names ${ref.service}.${ref.namespace}.svc, but no such Service is visible. It may be gone, or you may not have access to that namespace.`,
              },
            ],
            pods: [],
            attachments: [],
            hosts: [],
            outsideView: true,
            column: COLUMN.Service,
          });
        }

        addEdge(
          caller.id,
          targetId,
          "calls",
          ref.port ? `calls :${ref.port}` : "calls",
          `${ref.port ? `:${ref.port} · ` : ""}${source.via}`,
          true,
        );
      }
    }
  }

  const objectCounts: Record<string, number> = {};

  for (const list of [
    input.ingresses,
    input.services,
    input.deployments,
    input.statefulSets,
    input.daemonSets,
    input.replicaSets,
    input.cronJobs,
    input.jobs,
    input.pods,
    input.configMaps,
    input.persistentVolumeClaims,
    input.podDisruptionBudgets,
    input.networkPolicies,
    input.gateways ?? [],
    input.virtualServices ?? [],
  ]) {
    for (const o of list) {
      objectCounts[nsOf(o)] = (objectCounts[nsOf(o)] ?? 0) + 1;
    }
  }

  const total = Object.values(objectCounts).reduce((a, b) => a + b, 0);

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    hiddenCount: Math.max(0, total - nodes.size),
    collapsed: [...collapsed.values()],
    objectCounts,
  };
}

// ---------------------------------------------------------------- focus

/**
 * The selected namespaces in full, plus what they are linked to elsewhere: the other end of
 * every edge that leaves or enters the selection, and every route that brings traffic in
 * (load balancer -> Gateway -> VirtualService, in whatever namespace those live). Cards from
 * other namespaces are boxed by namespace; pods there stand in as their workload.
 */
export function focusTopology(graph: TopologyGraph, namespaces: string[] | undefined): TopologyGraph {
  if (!namespaces) {
    return graph;
  }

  const focus = new Set(namespaces);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const collapsed = new Map(graph.collapsed.map((n) => [n.id, n]));
  const resolve = (id: string) => {
    const n = byId.get(id);

    return n && !focus.has(n.namespace) && n.collapseTo && collapsed.has(n.collapseTo) ? n.collapseTo : id;
  };
  const kept = new Set(graph.nodes.filter((n) => focus.has(n.namespace)).map((n) => n.id));

  // Routes that bring traffic in, walked backwards from the selection.
  const routesInto = new Map<string, TopologyEdge[]>();

  for (const edge of graph.edges) {
    if (edge.type === "routes") {
      routesInto.set(edge.to, [...(routesInto.get(edge.to) ?? []), edge]);
    }
  }

  const entry = new Set<string>();
  const stack = [...kept];

  while (stack.length) {
    const current = stack.pop() as string;

    for (const edge of routesInto.get(current) ?? []) {
      if (!kept.has(edge.from) && !entry.has(edge.from)) {
        entry.add(edge.from);
        stack.push(edge.from);
      }
    }
  }

  const neighbours = new Set<string>();

  for (const edge of graph.edges) {
    const from = resolve(edge.from);
    const to = resolve(edge.to);

    if (kept.has(from) && !kept.has(to)) neighbours.add(to);
    if (kept.has(to) && !kept.has(from)) neighbours.add(from);
  }

  const visible = new Set([...kept, ...entry, ...neighbours]);
  const edges = new Map<string, TopologyEdge>();

  for (const edge of graph.edges) {
    const from = resolve(edge.from);
    const to = resolve(edge.to);

    if (from === to || !visible.has(from) || !visible.has(to)) {
      continue;
    }

    const touchesFocus = kept.has(from) || kept.has(to);
    const isEntryRoute = edge.type === "routes" && entry.has(from) && (entry.has(to) || kept.has(to));

    if (!touchesFocus && !isEntryRoute) {
      continue;
    }

    const id = `${edge.type}:${from}->${to}`;
    const existing = edges.get(id);

    if (existing) {
      existing.count += 1;
    } else {
      edges.set(id, { ...edge, id, from, to, count: 1 });
    }
  }

  const nodes: TopologyNode[] = [];

  for (const id of visible) {
    const n = byId.get(id) ?? collapsed.get(id);

    if (!n) {
      continue;
    }

    if (kept.has(id) || id === OUTSIDE) {
      nodes.push(n);
    } else {
      nodes.push({
        ...n,
        outsideView: true,
        group: `ns:${n.namespace}`,
        groupLabel: n.namespace,
        attachments: [],
        collapseTo: undefined,
      });
    }
  }

  const objects = namespaces.reduce((sum, ns) => sum + (graph.objectCounts[ns] ?? 0), 0);

  return {
    nodes,
    edges: [...edges.values()],
    hiddenCount: Math.max(0, objects - kept.size),
    collapsed: [],
    objectCounts: graph.objectCounts,
  };
}

// ---------------------------------------------------------------- overview

const namespaceId = (namespace: string) => `namespace/${namespace}`;

/**
 * One card per namespace, and one edge per pair of namespaces that are linked, summing up the
 * links of the network graph: calls found in configuration, routes from Gateways and
 * VirtualServices, and the way in from outside the cluster.
 */
export function buildOverview(network: TopologyGraph): TopologyGraph {
  const byId = new Map(network.nodes.map((n) => [n.id, n]));
  const namespaces = [
    ...new Set([...network.nodes.map((n) => n.namespace), ...Object.keys(network.objectCounts)].filter(Boolean)),
  ].sort();
  const nodes = new Map<string, TopologyNode>();

  for (const namespace of namespaces) {
    const members = network.nodes.filter((n) => n.namespace === namespace);
    const workloads = network.collapsed.filter((n) => n.namespace === namespace);
    const pods = members
      .filter((n) => n.kind === "Pod")
      .flatMap((n) => n.pods)
      .sort(
        (a, b) => ["err", "warn", "ok", "idle"].indexOf(a.status) - ["err", "warn", "ok", "idle"].indexOf(b.status),
      );
    const failing = pods.filter((p) => p.status === "err").length;
    const flagCounts = new Map<string, { flag: TopologyFlag; count: number }>();

    for (const member of members) {
      for (const flag of member.flags) {
        const entry = flagCounts.get(flag.text) ?? { flag, count: 0 };

        entry.count += 1;
        flagCounts.set(flag.text, entry);
      }
    }

    const flags: TopologyFlag[] = [];

    if (failing > 0) {
      flags.push({ text: `${failing} failing`, detail: `${plural(failing, "pod")} in an error state.` });
    }

    for (const { flag, count } of flagCounts.values()) {
      const where = members.filter((m) => m.flags.some((f) => f.text === flag.text)).map((m) => `${m.kind} ${m.name}`);

      flags.push({
        text: count > 1 ? `${flag.text} ×${count}` : flag.text,
        detail: `${flag.detail}\n${where.slice(0, 5).join("\n")}${where.length > 5 ? `\n+${where.length - 5} more` : ""}`,
      });
    }

    const hosts = [...new Set(members.flatMap((m) => m.hosts))];

    nodes.set(namespaceId(namespace), {
      id: namespaceId(namespace),
      kind: "Namespace",
      name: namespace,
      namespace,
      group: "",
      groupLabel: "",
      status: worst([...pods.map((p) => p.status), ...members.filter((m) => m.flags.length > 0).map((m) => m.status)]),
      summary: [plural(workloads.length, "workload"), plural(pods.length, "pod")].join(" · "),
      flags,
      pods,
      attachments: [],
      hosts,
      outsideView: false,
      column: 1,
    });
  }

  const outside = byId.get(OUTSIDE);

  if (outside) {
    nodes.set(OUTSIDE, { ...outside, column: 0 });
  }

  const ownerOf = (id: string) => {
    const n = byId.get(id);

    if (!n) {
      return undefined;
    }

    return n.id === OUTSIDE ? OUTSIDE : namespaceId(n.namespace);
  };
  const edges = new Map<string, TopologyEdge & { labels: Set<string>; examples: string[] }>();

  for (const edge of network.edges) {
    const from = ownerOf(edge.from);
    const to = ownerOf(edge.to);

    if (!from || !to || from === to || !nodes.has(from) || !nodes.has(to)) {
      continue;
    }

    const id = `${edge.type}:${from}->${to}`;
    const entry = edges.get(id) ?? {
      id,
      from,
      to,
      type: edge.type,
      label: "",
      via: "",
      inferred: edge.inferred,
      count: 0,
      labels: new Set<string>(),
      examples: [],
    };
    const fromNode = byId.get(edge.from);
    const toNode = byId.get(edge.to);
    const fromName = fromNode?.collapseTo?.split("/")[2] ?? fromNode?.name;
    const example = `${fromName} → ${toNode?.name} (${edge.via})`;

    entry.count += 1;
    entry.labels.add(edge.label);

    if (!entry.examples.includes(example)) {
      entry.examples.push(example);
    }

    edges.set(id, entry);
  }

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()].map(({ labels, examples, ...edge }) => ({
      ...edge,
      label: labels.size === 1 ? [...labels][0] : `${edge.type} ×${examples.length}`,
      via: examples.slice(0, 8).join("\n") + (examples.length > 8 ? `\n+${examples.length - 8} more` : ""),
    })),
    hiddenCount: 0,
    collapsed: [],
    objectCounts: network.objectCounts,
  };
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

  const outs = new Map<string, TopologyEdge[]>();
  const ins = new Map<string, TopologyEdge[]>();

  for (const edge of edges) {
    outs.set(edge.from, [...(outs.get(edge.from) ?? []), edge]);
    ins.set(edge.to, [...(ins.get(edge.to) ?? []), edge]);
  }

  for (const direction of ["down", "up"] as const) {
    const seen = new Set([start]);
    const stack = [start];

    while (stack.length) {
      const current = stack.pop() as string;

      for (const edge of (direction === "down" ? outs : ins).get(current) ?? []) {
        const next = direction === "down" ? edge.to : edge.from;

        edgeSet.add(edge.id);

        if (!seen.has(next)) {
          seen.add(next);
          nodeSet.add(next);
          stack.push(next);
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
  outsideView: boolean;
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
  Gateway: [220, 74],
  VirtualService: [220, 74],
  Service: [220, 74],
  Pod: [220, 56],
  Namespace: [240, 96],
};
const WORKLOAD_SIZE: [number, number] = [256, 96];
const GROUP_PAD = { top: 52, side: 20, bottom: 20 };
const COLUMN_GAP = 104; // room for an edge label between columns
const ROW_GAP = 14;
const GROUP_GAP_X = 96;
const GROUP_GAP_Y = 32;
// Groups that don't call each other would otherwise stack into one very tall column.
const MAX_COLUMN_HEIGHT = 1400;

const sizeOf = (n: TopologyNode): [number, number] => NODE_SIZE[n.kind] ?? WORKLOAD_SIZE;

/**
 * Longest-path depth of each key along the given links; cycles are cut after `keys.length` passes.
 * Keys in `fixed` keep the depth they start with.
 */
function depthsOf(
  keys: string[],
  links: [string, string][],
  start: Map<string, number> = new Map(),
  fixed: Set<string> = new Set(),
): Map<string, number> {
  const depth = new Map(keys.map((k) => [k, start.get(k) ?? 0]));

  for (let pass = 0; pass < keys.length; pass++) {
    let changed = false;

    for (const [from, to] of links) {
      const next = (depth.get(from) ?? 0) + 1;

      if (
        from !== to &&
        !fixed.has(to) &&
        depth.has(from) &&
        depth.has(to) &&
        (depth.get(to) ?? 0) < next &&
        next < keys.length
      ) {
        depth.set(to, next);
        changed = true;
      }
    }

    if (!changed) {
      break;
    }
  }

  return depth;
}

/**
 * Layered layout: groups (by app, or by namespace for cards outside the view) are placed in
 * columns by how they link to each other, left to right; inside a group, nodes are placed in
 * columns by kind and ordered to follow their neighbours (one barycentre pass), which keeps
 * most edges short and uncrossed. The overview, which has no groups, is laid out by
 * layoutOverview.
 */
export function layoutTopology(graph: TopologyGraph): TopologyLayout {
  if (graph.nodes.some((n) => n.kind === "Namespace")) {
    return layoutOverview(graph);
  }

  const groupIds = [...new Set(graph.nodes.filter((n) => n.kind !== "External").map((n) => n.group))].sort(
    (a, b) => Number(a.startsWith("ns:")) - Number(b.startsWith("ns:")) || a.localeCompare(b),
  );
  const groupOf = new Map(graph.nodes.map((n) => [n.id, n.group]));
  const depth = depthsOf(
    groupIds,
    graph.edges
      .map((e) => [groupOf.get(e.from) ?? "", groupOf.get(e.to) ?? ""] as [string, string])
      .filter(([from, to]) => from && to),
  );
  const namespaces = new Set(graph.nodes.filter((n) => !n.outsideView && n.namespace).map((n) => n.namespace));

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
      const groupHeight = GROUP_PAD.top + contentHeight + GROUP_PAD.bottom;
      const kinds = members.reduce<Record<string, number>>(
        (acc, n) => ({ ...acc, [n.kind]: (acc[n.kind] ?? 0) + 1 }),
        {},
      );
      const outsideView = groupId.startsWith("ns:");
      const first = members[0];

      laidGroups.push({
        id: groupId,
        label: first?.groupLabel ?? groupId,
        meta: [
          outsideView ? "other namespace" : namespaces.size > 1 ? first?.namespace : "",
          ...Object.entries(kinds).map(([kind, count]) => plural(count, kind)),
        ]
          .filter(Boolean)
          .join(" · "),
        outsideView,
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

    laidNodes.push({ ...outside, x: 24, y: Math.max(24, Math.round(centre - h / 2)), width: w, height: h });
  }

  return {
    nodes: laidNodes,
    groups: laidGroups,
    width: Math.max(x - GROUP_GAP_X + 24, 600),
    height: Math.max(totalHeight, 400),
  };
}

/**
 * The overview: linked namespaces in columns by who links to whom (outside first), the
 * namespaces without any link found in a grid underneath.
 */
export function layoutOverview(graph: TopologyGraph): TopologyLayout {
  const linked = new Set(graph.edges.flatMap((e) => [e.from, e.to]));
  const linkedNodes = graph.nodes.filter((n) => linked.has(n.id));
  const loose = graph.nodes.filter((n) => !linked.has(n.id) && n.id !== OUTSIDE);
  // Columns follow the way traffic comes in first (outside -> load balancer -> gateways -> apps);
  // calls then place what is only called to the right of its callers. A namespace that is both
  // an entry and called (istio-system) stays with the entry.
  const ids = linkedNodes.map((n) => n.id);
  const routes = graph.edges.filter((e) => e.type === "routes").map((e) => [e.from, e.to] as [string, string]);
  const routed = new Set(routes.flat());
  const depth = depthsOf(
    ids,
    graph.edges.filter((e) => e.type !== "routes").map((e) => [e.from, e.to]),
    depthsOf(ids, routes),
    routed,
  );
  const maxDepth = Math.max(0, ...depth.values());
  const [w, h] = NODE_SIZE.Namespace;
  const columnGap = 140;
  const position = new Map<string, number>();
  const laidNodes: LaidOutNode[] = [];
  let x = 24;
  let bottom = 24;

  for (let d = 0; d <= maxDepth; d++) {
    const inColumn = linkedNodes.filter((n) => depth.get(n.id) === d);
    const neighbourAverage = (n: TopologyNode) => {
      const ys = graph.edges
        .filter((e) => (e.to === n.id && position.has(e.from)) || (e.from === n.id && position.has(e.to)))
        .map((e) => position.get(e.to === n.id ? e.from : e.to) as number);

      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Number.POSITIVE_INFINITY;
    };

    inColumn.sort((a, b) => neighbourAverage(a) - neighbourAverage(b) || a.name.localeCompare(b.name));

    // Wrap a column that would get too tall into several.
    const perColumn = Math.max(1, Math.floor((MAX_COLUMN_HEIGHT - 24) / (h + ROW_GAP * 2)));

    for (let start = 0; start < inColumn.length; start += perColumn) {
      let y = 24;

      for (const n of inColumn.slice(start, start + perColumn)) {
        const [nw, nh] = sizeOf(n);

        laidNodes.push({ ...n, x, y, width: nw, height: nh });
        position.set(n.id, y + nh / 2);
        y += nh + ROW_GAP * 2;
      }

      bottom = Math.max(bottom, y);
      x += w + columnGap;
    }
  }

  const groups: LaidOutGroup[] = [];
  let width = Math.max(x - columnGap + 24, 600);

  if (loose.length > 0) {
    const top = linkedNodes.length > 0 ? bottom + 40 : 24;
    const perRow = Math.max(4, Math.floor((width - 2 * GROUP_PAD.side - 24) / (w + 20)));
    const rows = Math.ceil(loose.length / perRow);

    loose
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((n, index) => {
        laidNodes.push({
          ...n,
          x: 24 + GROUP_PAD.side + (index % perRow) * (w + 20),
          y: top + GROUP_PAD.top + Math.floor(index / perRow) * (h + ROW_GAP),
          width: w,
          height: h,
        });
      });

    const groupWidth = 2 * GROUP_PAD.side + Math.min(perRow, loose.length) * (w + 20) - 20;

    groups.push({
      id: "loose",
      label: "No links found",
      meta: `${plural(loose.length, "namespace")} with no route, call or entry linking them to another namespace`,
      outsideView: true,
      x: 24,
      y: top,
      width: groupWidth,
      height: GROUP_PAD.top + rows * (h + ROW_GAP) - ROW_GAP + GROUP_PAD.bottom,
    });
    width = Math.max(width, groupWidth + 48);
    bottom = top + groups[0].height + 24;
  }

  return { nodes: laidNodes, groups, width, height: Math.max(bottom, 400) };
}
