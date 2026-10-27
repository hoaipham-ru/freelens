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

import dagre from "@dagrejs/dagre";
import * as yaml from "js-yaml";

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
    annotations?: Record<string, string>;
    creationTimestamp?: string;
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
  /** Routes read from the Admin API of APISIX instances, which keep them in etcd, not in Kubernetes */
  apisix?: ApisixInstance[];
}

export interface ApisixRoute {
  id: string;
  name: string;
  hosts: string[];
  uris: string[];
  disabled: boolean;
  plugins: string[];
  upstreams: { host: string; port?: number }[];
}

export interface ApisixInstance {
  namespace: string;
  /** The Service of the Admin API */
  adminService: string;
  routes: ApisixRoute[];
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
const COLUMN: Record<string, number> = { Gateway: 0, VirtualService: 1, Ingress: 1, "APISIX route": 1, Service: 2 };
const WORKLOAD_COLUMN = 3;

// ---------------------------------------------------------------- helpers

export const keyOf = (kind: string, namespace: string, name: string) => `${kind.toLowerCase()}/${namespace}/${name}`;
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

export function podTemplateOf(o: RawObject): { labels: Record<string, string>; spec: any } {
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
export const isApiServer = (ref: CallReference) => ref.namespace === "default" && ref.service === "kubernetes";

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

// ---------------------------------------------------------------- APISIX

const APISIX_ADMIN_PORT = 9180;

/**
 * The Admin API Services of APISIX instances: port 9180, on a Service that names APISIX in its
 * name, labels or selector. Their routes are only reachable through that API.
 */
export function findApisixAdmins(services: RawObject[]): { namespace: string; name: string; port: number }[] {
  return services
    .filter((service) => {
      const ports: { port?: number }[] = service.spec?.ports ?? [];
      const mentions = [
        service.metadata.name,
        ...Object.values(service.metadata.labels ?? {}),
        ...Object.values((service.spec?.selector as Record<string, string>) ?? {}),
      ];

      return ports.some((p) => p.port === APISIX_ADMIN_PORT) && mentions.some((text) => /apisix/i.test(text));
    })
    .map((service) => ({ namespace: nsOf(service), name: service.metadata.name, port: APISIX_ADMIN_PORT }));
}

/** The objects of an Admin API list, in the v3 (`list`) or v2 (`node.nodes`) shape. */
function adminListOf(response: any): any[] {
  const items: { value?: unknown }[] = response?.list ?? response?.node?.nodes ?? [];

  return items.map((item) => item?.value).filter((value) => value && typeof value === "object");
}

function upstreamNodesOf(upstream: any): { host: string; port?: number }[] {
  if (!upstream) {
    return [];
  }

  if (upstream.discovery_type === "kubernetes" && typeof upstream.service_name === "string") {
    // "namespace/name:port"
    const match = /^([^/]+)\/([^:]+)(?::(.+))?$/.exec(upstream.service_name);

    if (match) {
      const port = Number(match[3]);

      return [{ host: `${match[2]}.${match[1]}.svc`, port: Number.isFinite(port) ? port : undefined }];
    }
  }

  const nodes = upstream.nodes;

  if (Array.isArray(nodes)) {
    return nodes
      .filter((node) => typeof node?.host === "string")
      .map((node) => ({ host: node.host, port: typeof node.port === "number" ? node.port : undefined }));
  }

  if (nodes && typeof nodes === "object") {
    return Object.keys(nodes).map((address) => {
      const [host, port] = address.split(":");

      return { host, port: port ? Number(port) : undefined };
    });
  }

  return [];
}

/**
 * Routes from the Admin API's responses for routes, upstreams and services: where each route's
 * traffic goes, whether its upstream is inline, referenced by id, or the one of its service.
 * Only names are kept of plugins: their configuration can hold secrets.
 */
export function parseApisixRoutes(
  routesResponse: unknown,
  upstreamsResponse?: unknown,
  servicesResponse?: unknown,
): ApisixRoute[] {
  const upstreams = new Map(adminListOf(upstreamsResponse).map((u) => [String(u.id), u]));
  const services = new Map(adminListOf(servicesResponse).map((s) => [String(s.id), s]));
  const upstreamOf = (owner: any): any =>
    owner?.upstream ?? (owner?.upstream_id !== undefined ? upstreams.get(String(owner.upstream_id)) : undefined);

  return adminListOf(routesResponse).map((route) => {
    const service = route.service_id !== undefined ? services.get(String(route.service_id)) : undefined;
    const strings = (...values: unknown[]) =>
      values
        .flatMap((value) => (Array.isArray(value) ? value : value ? [value] : []))
        .filter((v) => typeof v === "string");

    return {
      id: String(route.id ?? ""),
      name: typeof route.name === "string" ? route.name.trim() : "",
      hosts: strings(route.host, route.hosts, service?.hosts),
      uris: strings(route.uri, route.uris),
      disabled: route.status === 0,
      plugins: [...new Set([...Object.keys(route.plugins ?? {}), ...Object.keys(service?.plugins ?? {})])].sort(),
      upstreams: upstreamNodesOf(upstreamOf(route) ?? upstreamOf(service)),
    };
  });
}

/**
 * The key of the read-only `viewer` role, from an APISIX ConfigMap (config.yaml) in the given
 * namespace. Never the admin key: Topology only reads. A key given as an environment variable
 * (`${{ADMIN_KEY}}`) is not in the ConfigMap, so there is none to find.
 */
export function findApisixViewerKey(configMaps: RawObject[], namespace: string): string | undefined {
  for (const configMap of configMaps) {
    if (nsOf(configMap) !== namespace) {
      continue;
    }

    for (const text of Object.values(configMap.data ?? {})) {
      if (typeof text !== "string" || !text.includes("admin_key")) {
        continue;
      }

      let config: any;

      try {
        config = yaml.load(text);
      } catch {
        continue;
      }

      const keys: unknown = config?.deployment?.admin?.admin_key ?? config?.apisix?.admin_key;
      const viewer = Array.isArray(keys)
        ? keys.find((entry) => entry?.role === "viewer" && typeof entry.key === "string" && entry.key.trim())
        : undefined;

      if (viewer && !viewer.key.includes("${{")) {
        return viewer.key.trim();
      }
    }
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

  // APISIX routes: its gateway Service -> route -> upstream Service.
  for (const instance of input.apisix ?? []) {
    const admin = services.find((s) => nsOf(s) === instance.namespace && s.metadata.name === instance.adminService);
    const adminSelector = JSON.stringify(admin?.spec?.selector ?? null);
    // The data plane: the other Services that select the same pods as the Admin API.
    const gatewayServices = services.filter(
      (s) =>
        nsOf(s) === instance.namespace &&
        s !== admin &&
        s.spec?.clusterIP !== "None" &&
        JSON.stringify(s.spec?.selector ?? null) === adminSelector &&
        !(s.spec?.ports ?? []).some((p: { port?: number }) => p.port === APISIX_ADMIN_PORT),
    );

    for (const route of instance.routes) {
      const id = keyOf("apisixroute", instance.namespace, route.id);
      const uris = route.uris.filter((uri) => uri !== "/*");
      const flags: TopologyFlag[] = [];
      const targets = route.upstreams.map((u) => ({
        ...u,
        target: resolveServiceHost(u.host, instance.namespace, knownServices),
      }));

      nodes.set(id, {
        id,
        kind: "APISIX route",
        name: route.name || listSummary(route.hosts) || route.id,
        namespace: instance.namespace,
        group: `${instance.namespace}/apisix-routes`,
        groupLabel: "APISIX routes",
        status: route.disabled ? "idle" : "ok",
        summary: [listSummary(route.hosts, "any host"), uris.join(" "), route.plugins.join(", ")]
          .filter(Boolean)
          .join(" · "),
        flags: route.disabled ? [{ text: "disabled", detail: "This route is turned off in APISIX." }] : [],
        pods: [],
        attachments: [],
        hosts: route.hosts,
        outsideView: false,
        column: COLUMN["APISIX route"],
      });

      for (const service of gatewayServices) {
        addEdge(
          keyOf("Service", nsOf(service), service.metadata.name),
          id,
          "routes",
          `routes ${[listSummary(route.hosts), uris[0]].filter(Boolean).join(" ")}`.trim(),
          `APISIX route ${route.id}: ${[route.hosts.join(", ") || "any host", route.uris.join(", ")].join(" ")}`,
        );
      }

      for (const { host, port, target } of targets) {
        const serviceId = target && keyOf("Service", target.namespace, target.service);

        if (serviceId && nodes.has(serviceId)) {
          addEdge(
            id,
            serviceId,
            "routes",
            port ? `routes :${port}` : "routes",
            `upstream ${host}${port ? `:${port}` : ""}`,
          );
        } else if (target) {
          flags.push({ text: "no such Service", detail: `The upstream ${host} matches no Service.` });
        } else {
          flags.push({ text: "outside upstream", detail: `The upstream ${host} is not a Service of this cluster.` });
        }
      }

      const routeNode = nodes.get(id);

      if (routeNode && flags.length > 0) {
        routeNode.flags = [...routeNode.flags, ...flags];
        routeNode.status = flags.some((f) => f.text === "no such Service") ? "err" : "warn";
      }
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
    (input.apisix ?? []).flatMap((instance) =>
      instance.routes.map((route) => ({ metadata: { name: route.id, namespace: instance.namespace } })),
    ),
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

/** Whether host `a` covers host `b` or the other way round, with `*` and `*.domain` wildcards. */
function hostsMeet(a: string, b: string): boolean {
  const covers = (pattern: string, host: string) =>
    pattern === "*" || pattern === host || (pattern.startsWith("*.") && host.endsWith(pattern.slice(1)));

  return covers(a, b) || covers(b, a);
}

/**
 * The hosts a route walked back so far still applies to, given the hosts of the next node:
 * undefined when they have nothing in common. A node without hosts lets everything through.
 */
function narrowHosts(sofar: string[], next: string[]): string[] | undefined {
  if (next.length === 0) {
    return sofar;
  }

  if (sofar.length === 0) {
    return next;
  }

  const common = sofar.filter((host) => next.some((other) => hostsMeet(host, other)));

  return common.length > 0 ? common : undefined;
}

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

  // Walking back, the host names seen so far narrow the way: a shared gateway Service receives
  // traffic for many hosts, and only the routes for this app's hosts belong to its story.
  const entry = new Set<string>();
  const stack: { id: string; hosts: string[] }[] = [...kept].map((id) => ({ id, hosts: [] }));

  while (stack.length) {
    const { id: current, hosts } = stack.pop() as { id: string; hosts: string[] };

    for (const edge of routesInto.get(current) ?? []) {
      const from = byId.get(edge.from);

      if (!from || kept.has(edge.from) || entry.has(edge.from)) {
        continue;
      }

      const narrowed = narrowHosts(hosts, from.hosts);

      if (narrowed) {
        entry.add(edge.from);
        stack.push({ id: edge.from, hosts: narrowed });
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

export interface PathResult {
  nodes: Set<string>;
  edges: Set<string>;
  upstream: Set<string>;
  downstream: Set<string>;
}

/** Everything reachable from `start` along edges, plus everything that reaches it. */
export function pathOf(edges: TopologyEdge[], start: string | undefined): PathResult {
  const nodeSet = new Set<string>();
  const edgeSet = new Set<string>();
  const upstream = new Set<string>();
  const downstream = new Set<string>();

  if (!start) {
    return { nodes: nodeSet, edges: edgeSet, upstream, downstream };
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
          if (direction === "up") {
            upstream.add(next);
          } else {
            downstream.add(next);
          }
          stack.push(next);
        }
      }
    }
  }

  return { nodes: nodeSet, edges: edgeSet, upstream, downstream };
}

// ---------------------------------------------------------------- layout

export interface Point {
  x: number;
  y: number;
}

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
  /** Each edge as an orthogonal polyline, from the side of its source to the side of its target */
  routes: Record<string, Point[]>;
  width: number;
  height: number;
}

const NODE_SIZE: Record<string, [number, number]> = {
  External: [180, 56],
  Ingress: [230, 60],
  Gateway: [230, 60],
  VirtualService: [230, 60],
  "APISIX route": [230, 60],
  Service: [230, 60],
  Pod: [230, 56],
  Namespace: [250, 92],
};
const WORKLOAD_SIZE: [number, number] = [250, 92];
const NODE_GAP = 28; // between cards of one column, and room for a box's name
const RANK_GAP = 96; // between columns: where the lines turn, and their labels
const GROUP_PAD = { top: 34, side: 14, bottom: 14 };
const PACK_GAP = 56;
const MARGIN = 24;

// A pod on its own carries what it mounts, like a workload card.
const sizeOf: SizeOf = (n) =>
  n.kind === "Pod" && n.attachments.length > 0 ? WORKLOAD_SIZE : (NODE_SIZE[n.kind] ?? WORKLOAD_SIZE);

const COMPACT_NODE_SIZE: Record<string, [number, number]> = {
  External: [120, 32],
  Ingress: [130, 34],
  Gateway: [130, 34],
  VirtualService: [130, 34],
  "APISIX route": [130, 34],
  Service: [130, 34],
  Pod: [130, 34],
  Namespace: [140, 48],
};
const COMPACT_WORKLOAD_SIZE: [number, number] = [140, 42];

export const compactSizeOf: SizeOf = (n) => COMPACT_NODE_SIZE[n.kind] ?? COMPACT_WORKLOAD_SIZE;

export type SizeOf = (node: TopologyNode) => [number, number];

interface ComponentLayout {
  nodes: LaidOutNode[];
  groups: LaidOutGroup[];
  routes: Record<string, Point[]>;
  width: number;
  height: number;
}

/** Nodes that are tied together, by an edge or by sharing a box; each part is laid out on its own. */
function componentsOf(graph: TopologyGraph, grouped: boolean): TopologyNode[][] {
  const parent = new Map(graph.nodes.map((n) => [n.id, n.id]));
  const find = (id: string): string => {
    let root = id;

    while (parent.get(root) !== root) {
      root = parent.get(root) as string;
    }

    parent.set(id, root);

    return root;
  };
  const union = (a: string, b: string) => {
    if (parent.has(a) && parent.has(b)) {
      parent.set(find(a), find(b));
    }
  };
  const firstOfGroup = new Map<string, string>();

  for (const edge of graph.edges) {
    union(edge.from, edge.to);
  }

  if (grouped) {
    for (const n of graph.nodes) {
      if (n.group) {
        const first = firstOfGroup.get(n.group);

        if (first) {
          union(n.id, first);
        } else {
          firstOfGroup.set(n.group, n.id);
        }
      }
    }
  }

  const parts = new Map<string, TopologyNode[]>();

  for (const n of graph.nodes) {
    const root = find(n.id);

    parts.set(root, [...(parts.get(root) ?? []), n]);
  }

  return [...parts.values()];
}

/**
 * Turns the points dagre leaves along an edge into right angles that bend only in the gaps between
 * columns. Every line into a node bends in the same gap, at the same x, so lines that meet run
 * together into one trunk, as on a bus.
 */
function orthogonalRoute(
  from: LaidOutNode,
  to: LaidOutNode,
  via: Point[],
  columns: { left: number; right: number; centre: number }[],
): Point[] {
  const columnOf = (x: number) =>
    columns.reduce(
      (best, column, index) => (Math.abs(column.centre - x) < Math.abs(columns.at(best)!.centre - x) ? index : best),
      0,
    );
  const gapBefore = (index: number) =>
    index > 0 ? (columns.at(index - 1)!.right + columns.at(index)!.left) / 2 : columns.at(0)!.left - RANK_GAP / 2;
  const gapAfter = (index: number) =>
    index < columns.length - 1
      ? (columns.at(index)!.right + columns.at(index + 1)!.left) / 2
      : columns.at(-1)!.right + RANK_GAP / 2;
  const forwards = to.x + to.width / 2 >= from.x + from.width / 2;
  const start = { x: forwards ? from.x + from.width : from.x, y: from.y + from.height / 2 };
  const end = { x: forwards ? to.x : to.x + to.width, y: to.y + to.height / 2 };
  // Keep only the points dagre placed in a column (its dummy nodes, which hold a free slot there).
  const slots = via.filter((p) => columns.some((c) => Math.abs(c.centre - p.x) < 1));
  const targets = [...slots, end];
  const points: Point[] = [start];

  for (const target of targets) {
    const previous = points.at(-1) as Point;

    if (Math.abs(previous.y - target.y) < 0.5) {
      points.push(target);
      continue;
    }

    const column = columnOf(target === end ? to.x + to.width / 2 : target.x);
    const turn = forwards ? gapBefore(column) : gapAfter(column);

    points.push({ x: turn, y: previous.y }, { x: turn, y: target.y }, target);
  }

  // Drop points in the middle of straight runs.
  return points.filter((p, index) => {
    const before = points.at(index - 1);
    const after = points.at(index + 1);

    if (index === 0 || index === points.length - 1 || !before || !after) {
      return true;
    }

    const straight = (before.x === p.x && p.x === after.x) || (before.y === p.y && p.y === after.y);

    return !straight;
  });
}

/**
 * Upstream entry nodes from outside the selected namespaces (Outside -> LB Service -> Gateway ->
 * VirtualService -> APISIX route) that only feed traffic into the in-view nodes. Stacking a
 * multi-hop entry chain top-to-bottom in a single left column keeps a long cross-namespace
 * routing chain from stretching across 4–5 horizontal columns before the namespace itself begins.
 */
function upstreamEntryChain(members: TopologyNode[], edges: TopologyEdge[], grouped: boolean): TopologyNode[] {
  if (!grouped) {
    return [];
  }

  const inView = new Set(members.filter((n) => !n.outsideView && n.id !== OUTSIDE).map((n) => n.id));

  if (inView.size === 0) {
    return [];
  }

  const reachedFromInView = new Set<string>();
  const downQueue = [...inView];

  while (downQueue.length) {
    const current = downQueue.pop() as string;

    for (const e of edges) {
      if (e.from === current && !inView.has(e.to) && !reachedFromInView.has(e.to)) {
        reachedFromInView.add(e.to);
        downQueue.push(e.to);
      }
    }
  }

  const byId = new Map(members.map((n) => [n.id, n]));
  const entrySet = new Set<string>();
  const upQueue = [...inView];

  while (upQueue.length) {
    const current = upQueue.pop() as string;

    for (const e of edges) {
      if (e.type !== "routes" || e.to !== current) {
        continue;
      }

      const from = byId.get(e.from);

      if (
        from &&
        (from.outsideView || from.id === OUTSIDE) &&
        !inView.has(from.id) &&
        !reachedFromInView.has(from.id) &&
        !entrySet.has(from.id)
      ) {
        entrySet.add(from.id);
        upQueue.push(from.id);
      }
    }
  }

  if (entrySet.size < 2) {
    return [];
  }

  const entryEdges = edges.filter((e) => entrySet.has(e.from) && entrySet.has(e.to));
  const depth = new Map<string, number>();

  for (const id of entrySet) {
    depth.set(id, id === OUTSIDE ? -1 : 0);
  }

  for (let step = 0; step < entrySet.size; step++) {
    for (const e of entryEdges) {
      const nextDepth = (depth.get(e.from) ?? 0) + 1;

      if (nextDepth > (depth.get(e.to) ?? 0)) {
        depth.set(e.to, nextDepth);
      }
    }
  }

  const groupDepth = new Map<string, number>();

  for (const id of entrySet) {
    const g = byId.get(id)?.group ?? "";
    const d = depth.get(id) ?? 0;

    groupDepth.set(g, Math.min(groupDepth.get(g) ?? d, d));
  }

  return [...entrySet]
    .map((id) => byId.get(id) as TopologyNode)
    .sort(
      (a, b) =>
        (groupDepth.get(a.group) ?? 0) - (groupDepth.get(b.group) ?? 0) ||
        a.group.localeCompare(b.group) ||
        (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0) ||
        a.column - b.column ||
        a.name.localeCompare(b.name),
    );
}

function layoutComponent(
  graph: TopologyGraph,
  members: TopologyNode[],
  grouped: boolean,
  size: SizeOf = sizeOf,
): ComponentLayout {
  const ids = new Set(members.map((n) => n.id));
  const edges = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const entryNodes = upstreamEntryChain(members, edges, grouped);
  const entrySet = new Set(entryNodes.map((n) => n.id));
  const restMembers = entrySet.size > 0 ? members.filter((n) => !entrySet.has(n.id)) : members;
  const entryOffsets: { node: TopologyNode; dx: number; dy: number; width: number; height: number }[] = [];
  let entryWidth = 0;
  let entryHeight = 0;

  if (entryNodes.length > 0) {
    entryWidth = Math.max(...entryNodes.map((n) => size(n)[0]));
    let entryY = 0;

    entryNodes.forEach((n, index) => {
      const [w, h] = size(n);
      const prev = index > 0 ? entryNodes[index - 1] : undefined;

      if (prev) {
        const sameGroup = prev.group === n.group;
        const prevBoxed = Boolean(prev.group && prev.kind !== "External");
        const currBoxed = Boolean(n.group && n.kind !== "External");

        entryY += sameGroup
          ? NODE_GAP
          : (prevBoxed ? GROUP_PAD.bottom : 0) + NODE_GAP + (currBoxed ? GROUP_PAD.top : 0);
      } else if (n.group && n.kind !== "External") {
        entryY += GROUP_PAD.top;
      }

      entryOffsets.push({ node: n, dx: (entryWidth - w) / 2, dy: entryY, width: w, height: h });
      entryY += h;
    });

    const lastEntry = entryNodes.at(-1);

    entryHeight = entryY + (lastEntry?.group && lastEntry.kind !== "External" ? GROUP_PAD.bottom : 0);
  }

  // dagre breaks (a line it can't clip to its cards) when several lines join the same two cards,
  // or run both ways between them. So it gets one line per pair of cards, and each of ours
  // follows the one for its pair, turned around when it goes the other way.
  //
  // It also can't keep a box together when a line leaves the box and comes back (A -> B -> A, with
  // B outside the box). A line that would close such a loop between boxes is not given to dagre:
  // it is still drawn, from where the cards end up.
  const pairs = new Map<string, { v: string; w: string; weight: number }>();
  const pairOfEdge = new Map<string, { key: string; reversed: boolean }>();
  const clusterOf = (id: string) => {
    const n = id === "__entry__" ? undefined : restMembers.find((m) => m.id === id);

    return grouped && n?.group && n.kind !== "External" ? `group:${n.group}` : id;
  };
  const clusterLinks = new Map<string, Set<string>>();
  const clusterReaches = (from: string, to: string) => {
    const seen = new Set([from]);
    const stack = [from];

    while (stack.length > 0) {
      const current = stack.pop() as string;

      if (current === to) {
        return true;
      }

      for (const next of clusterLinks.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }

    return false;
  };
  const addPair = (v: string, w: string, weight: number, edgeId?: string) => {
    if (v === w) {
      return;
    }

    const forward = `${v}\u0000${w}`;
    const backward = `${w}\u0000${v}`;
    const reversed = !pairs.has(forward) && pairs.has(backward);
    const key = reversed ? backward : forward;

    if (!pairs.has(key) && grouped) {
      const from = clusterOf(v);
      const to = clusterOf(w);

      if (from !== to) {
        if (clusterReaches(to, from)) {
          return;
        }

        clusterLinks.set(from, (clusterLinks.get(from) ?? new Set<string>()).add(to));
      }
    }

    const pair = pairs.get(key) ?? { v: reversed ? w : v, w: reversed ? v : w, weight: 0 };

    pair.weight += weight;
    pairs.set(key, pair);

    if (edgeId !== undefined) {
      pairOfEdge.set(edgeId, { key, reversed });
    }
  };

  // Routes and exposes are the structure, so they are placed first; calls may bend more.
  for (const edge of [...edges].sort((a, b) => Number(a.type === "calls") - Number(b.type === "calls"))) {
    if (entrySet.has(edge.from) && entrySet.has(edge.to)) {
      continue;
    }

    addPair(
      entrySet.has(edge.from) ? "__entry__" : edge.from,
      entrySet.has(edge.to) ? "__entry__" : edge.to,
      edge.type === "calls" ? 1 : 4,
      edge.id,
    );
  }

  if (entryNodes.length > 0) {
    // Keep the stacked entry column strictly to the left of the namespace's own columns.
    const hasIncoming = new Set(edges.filter((e) => !entrySet.has(e.from) || !entrySet.has(e.to)).map((e) => e.to));

    for (const n of restMembers) {
      if (!hasIncoming.has(n.id)) {
        addPair("__entry__", n.id, 0);
      }
    }
  }

  const runDagre = (compound: boolean) => {
    const graph = new dagre.graphlib.Graph({ compound, multigraph: true });

    graph.setGraph({ rankdir: "LR", nodesep: NODE_GAP, ranksep: RANK_GAP, edgesep: 12, marginx: 0, marginy: 0 });
    graph.setDefaultEdgeLabel(() => ({}));

    if (entryNodes.length > 0) {
      graph.setNode("__entry__", { width: entryWidth, height: entryHeight });
    }

    for (const n of restMembers) {
      const [width, height] = size(n);

      graph.setNode(n.id, { width, height });

      if (compound && n.group && n.kind !== "External") {
        graph.setNode(`group:${n.group}`, {});
        graph.setParent(n.id, `group:${n.group}`);
      }
    }

    for (const [key, { v, w, weight }] of pairs) {
      graph.setEdge(v, w, { weight, minlen: 1 }, key);
    }

    dagre.layout(graph);

    return graph;
  };

  let g: ReturnType<typeof runDagre>;

  try {
    g = runDagre(grouped);
  } catch (error) {
    if (!grouped) {
      throw error;
    }

    // dagre can't keep a box together when a line leaves it and comes back (A -> B -> A, B outside
    // the box). Rather than crash the page, lay the cards out without boxes: the boxes are still
    // drawn around their cards afterwards.
    g = runDagre(false);
  }

  // Compound groups in dagre add empty borderLeft/borderRight ranks that inflate horizontal gaps
  // between columns to 2–3x RANK_GAP. Compact real node columns back to a uniform RANK_GAP.
  const dagreNodeIds = [...(entryNodes.length > 0 ? ["__entry__"] : []), ...restMembers.map((n) => n.id)];
  const rawPlaced = new Map(
    dagreNodeIds.map((id) => {
      const p = g.node(id) as { x: number; y: number; width: number; height: number };

      return [id, { x: p.x - p.width / 2, y: p.y - p.height / 2, width: p.width, height: p.height, centre: p.x }];
    }),
  );
  const rawCentres = [...new Set([...rawPlaced.values()].map((p) => Math.round(p.centre)))].sort((a, b) => a - b);
  const centreShift = new Map<number, number>();
  let nextLeft = 0;

  for (const oldCentre of rawCentres) {
    const inCol = [...rawPlaced.values()].filter((p) => Math.abs(p.centre - oldCentre) < 1);
    const colWidth = Math.max(...inCol.map((p) => p.width));
    const newCentre = nextLeft + colWidth / 2;

    centreShift.set(oldCentre, newCentre - oldCentre);

    for (const p of inCol) {
      p.x = newCentre - p.width / 2;
      p.centre = newCentre;
    }

    nextLeft += colWidth + RANK_GAP;
  }

  const shiftWaypoint = (p: Point): Point => {
    const match = rawCentres.find((c) => Math.abs(c - p.x) < 1);

    return match !== undefined ? { x: p.x + (centreShift.get(match) ?? 0), y: p.y } : p;
  };

  const laid: LaidOutNode[] = [];

  if (entryNodes.length > 0) {
    const entryPlaced = rawPlaced.get("__entry__")!;

    for (const { node, dx, dy, width, height } of entryOffsets) {
      laid.push({
        ...node,
        x: entryPlaced.x + dx,
        y: entryPlaced.y + dy,
        width,
        height,
      });
    }
  }

  for (const n of restMembers) {
    const placed = rawPlaced.get(n.id)!;

    laid.push({
      ...n,
      x: placed.x,
      y: placed.y,
      width: placed.width,
      height: placed.height,
    });
  }

  const byId = new Map(laid.map((n) => [n.id, n]));
  const groups: LaidOutGroup[] = [];
  const namespaces = new Set(members.filter((n) => !n.outsideView && n.namespace).map((n) => n.namespace));

  for (const groupId of grouped ? [...new Set(members.map((n) => n.group).filter(Boolean))] : []) {
    const inside = laid.filter((n) => n.group === groupId && n.kind !== "External");

    if (inside.length === 0) {
      continue;
    }

    const inEntry = inside.every((n) => entrySet.has(n.id));
    const box = inEntry
      ? undefined
      : (g.node(`group:${groupId}`) as { x: number; y: number; width: number; height: number } | undefined);
    const minX = Math.min(...inside.map((n) => n.x)) - GROUP_PAD.side;
    const maxX = Math.max(...inside.map((n) => n.x + n.width)) + GROUP_PAD.side;
    const minY = Math.min(...inside.map((n) => n.y)) - GROUP_PAD.top;
    const maxY = Math.max(...inside.map((n) => n.y + n.height)) + GROUP_PAD.bottom;
    // dagre's own box holds the room it kept for the group, top to bottom, in every column it
    // spans; side to side its border columns are wider than needed, so the cards decide.
    const x0 = minX;
    const x1 = maxX;
    const y0 = Math.min(minY, box ? box.y - box.height / 2 : minY);
    const y1 = Math.max(maxY, box ? box.y + box.height / 2 : maxY);
    const kinds = inside.reduce<Record<string, number>>((acc, n) => ({ ...acc, [n.kind]: (acc[n.kind] ?? 0) + 1 }), {});
    const outsideView = groupId.startsWith("ns:");
    const first = inside.at(0);

    groups.push({
      id: groupId,
      label: first?.groupLabel ?? groupId,
      meta: [
        outsideView ? "other namespace" : namespaces.size > 1 ? first?.namespace : "",
        ...Object.entries(kinds).map(([kind, count]) => plural(count, kind)),
      ]
        .filter(Boolean)
        .join(" · "),
      outsideView,
      x: x0,
      y: y0,
      width: x1 - x0,
      height: y1 - y0,
    });
  }

  const columns = [...new Set(laid.map((n) => Math.round(n.x + n.width / 2)))]
    .sort((a, b) => a - b)
    .map((centre) => {
      const inColumn = laid.filter((n) => Math.abs(n.x + n.width / 2 - centre) < 1);

      return {
        centre,
        left: Math.min(...inColumn.map((n) => n.x)),
        right: Math.max(...inColumn.map((n) => n.x + n.width)),
      };
    });
  const routes: Record<string, Point[]> = {};

  for (const edge of edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);

    if (!from || !to) {
      continue;
    }

    if (entrySet.has(edge.from) && entrySet.has(edge.to)) {
      const fromIndex = entryNodes.findIndex((n) => n.id === edge.from);
      const toIndex = entryNodes.findIndex((n) => n.id === edge.to);

      if (toIndex === fromIndex + 1) {
        routes[edge.id] = [
          { x: from.x + from.width / 2, y: from.y + from.height },
          { x: to.x + to.width / 2, y: to.y },
        ];
      } else {
        const sideX = Math.max(from.x + from.width, to.x + to.width) + GROUP_PAD.side + 12;

        routes[edge.id] = [
          { x: from.x + from.width, y: from.y + from.height / 2 },
          { x: sideX, y: from.y + from.height / 2 },
          { x: sideX, y: to.y + to.height / 2 },
          { x: to.x + to.width, y: to.y + to.height / 2 },
        ];
      }

      continue;
    }

    const pair = pairOfEdge.get(edge.id);
    const dagreEdge = pair ? pairs.get(pair.key) : undefined;
    const placed = dagreEdge
      ? (g.edge({ v: dagreEdge.v, w: dagreEdge.w, name: pair?.key }) as { points?: Point[] } | undefined)
      : undefined;
    const inner = (placed?.points ?? []).slice(1, -1);
    const waypoints = (pair?.reversed ? inner.reverse() : inner).map(shiftWaypoint);

    routes[edge.id] = orthogonalRoute(from, to, waypoints, columns);
  }

  // Move everything to start at 0, 0.
  const boxes = [...laid, ...groups];
  const left = Math.min(
    ...boxes.map((b) => b.x),
    ...Object.values(routes)
      .flat()
      .map((p) => p.x),
  );
  const topEdge = Math.min(
    ...boxes.map((b) => b.y),
    ...Object.values(routes)
      .flat()
      .map((p) => p.y),
  );
  const shift = <T extends { x: number; y: number }>(b: T): T => ({ ...b, x: b.x - left, y: b.y - topEdge });

  const shiftedNodes = laid.map(shift);
  const shiftedGroups = groups.map(shift);
  const shiftedRoutes = Object.fromEntries(Object.entries(routes).map(([id, points]) => [id, points.map(shift)]));
  const all = [...shiftedNodes, ...shiftedGroups];

  return {
    nodes: shiftedNodes,
    groups: shiftedGroups,
    routes: shiftedRoutes,
    width: Math.max(...all.map((b) => b.x + b.width)),
    height: Math.max(...all.map((b) => b.y + b.height)),
  };
}

/**
 * Lays each part out with dagre (layers left to right, fewest crossings, room kept for lines
 * that skip a column), then packs the parts in rows: the biggest first, and the parts made
 * of one node apart at the end, in a box of their own when `looseLabel` names it.
 */
function layoutParts(graph: TopologyGraph, grouped: boolean, looseLabel?: string, size?: SizeOf): TopologyLayout {
  const parts = componentsOf(graph, grouped)
    .map((members) => ({ members, layout: layoutComponent(graph, members, grouped, size) }))
    .sort(
      (a, b) =>
        Number(a.members.length === 1) - Number(b.members.length === 1) ||
        b.members.length - a.members.length ||
        a.members[0].name.localeCompare(b.members[0].name),
    );
  // Rows about 1.8 times as wide as the whole is tall, so many small parts make a block, not a strip.
  const area = parts.reduce((sum, p) => sum + (p.layout.width + PACK_GAP) * (p.layout.height + PACK_GAP), 0);
  const maxRow = Math.max(1200, Math.sqrt(area * 1.8), ...parts.map((p) => p.layout.width));
  const nodes: LaidOutNode[] = [];
  const groups: LaidOutGroup[] = [];
  const routes: Record<string, Point[]> = {};
  let x = MARGIN;
  let y = MARGIN;
  let rowHeight = 0;
  let width = 0;
  let looseTop: number | undefined;

  for (const { members, layout } of parts) {
    const loose = members.length === 1 && looseLabel !== undefined;

    if (loose && looseTop === undefined) {
      // The parts with nothing linked start a row of their own, under a name.
      y += rowHeight + (rowHeight > 0 ? PACK_GAP : 0);
      x = MARGIN + GROUP_PAD.side;
      rowHeight = 0;
      looseTop = y;
      y += GROUP_PAD.top;
    } else if (x > MARGIN + (looseTop !== undefined ? GROUP_PAD.side : 0) && x + layout.width > maxRow) {
      y += rowHeight + PACK_GAP / (loose ? 2 : 1);
      x = MARGIN + (looseTop !== undefined ? GROUP_PAD.side : 0);
      rowHeight = 0;
    }

    for (const n of layout.nodes) nodes.push({ ...n, x: n.x + x, y: n.y + y });
    for (const group of layout.groups) groups.push({ ...group, x: group.x + x, y: group.y + y });
    for (const [id, points] of Object.entries(layout.routes))
      routes[id] = points.map((p) => ({ x: p.x + x, y: p.y + y }));

    width = Math.max(width, x + layout.width);
    rowHeight = Math.max(rowHeight, layout.height);
    x += layout.width + (loose ? PACK_GAP / 2 : PACK_GAP);
  }

  let height = y + rowHeight;

  if (looseTop !== undefined && looseLabel) {
    const loose = nodes.filter((n) => n.y >= looseTop);
    const right = Math.max(...loose.map((n) => n.x + n.width)) + GROUP_PAD.side;

    groups.push({
      id: "loose",
      label: looseLabel,
      meta: `${plural(loose.length, "namespace")} with no route, call or entry linking them to another namespace`,
      outsideView: true,
      x: MARGIN,
      y: looseTop,
      width: right - MARGIN,
      height: height - looseTop + GROUP_PAD.bottom,
    });
    height += GROUP_PAD.bottom;
    width = Math.max(width, right);
  }

  return { nodes, groups, routes, width: Math.max(width + MARGIN, 600), height: Math.max(height + MARGIN, 400) };
}

/** The detailed views: boxes by app, or by namespace for cards outside the view. */
export function layoutTopology(graph: TopologyGraph, options?: { size?: SizeOf }): TopologyLayout {
  if (graph.nodes.some((n) => n.kind === "Namespace")) {
    return layoutOverview(graph);
  }

  return layoutParts(graph, true, undefined, options?.size);
}

/** The overview: linked namespaces left to right as traffic comes in; the rest in a box underneath. */
export function layoutOverview(graph: TopologyGraph): TopologyLayout {
  return layoutParts(graph, false, "No links found");
}

/** Any graph of cards, left to right as traffic goes, in the sizes given: the Service map uses it. */
export function layoutCards(graph: TopologyGraph, size: SizeOf): TopologyLayout {
  return layoutParts(graph, false, undefined, size);
}
