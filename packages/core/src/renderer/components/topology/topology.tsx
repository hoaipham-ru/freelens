/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { withInjectables } from "@ogre-tools/injectable-react";
import { action, computed, observable, reaction, runInAction } from "mobx";
import { observer } from "mobx-react";
import React from "react";
import apiManagerInjectable from "../../../common/k8s-api/api-manager/manager.injectable";
import clusterFrameContextForNamespacedResourcesInjectable from "../../cluster-frame-context/for-namespaced-resources.injectable";
import apiKubeInjectable from "../../k8s/api-kube.injectable";
import subscribeStoresInjectable from "../../kube-watch-api/subscribe-stores.injectable";
import configMapStoreInjectable from "../config-maps/store.injectable";
import podDisruptionBudgetStoreInjectable from "../config-pod-disruption-budgets/store.injectable";
import customResourceDefinitionStoreInjectable from "../custom-resource-definitions/store.injectable";
import showDetailsInjectable from "../kube-detail-params/show-details.injectable";
import { TabLayout } from "../layout/tab-layout";
import { NamespaceSelectFilter } from "../namespaces/namespace-select-filter";
import namespaceStoreInjectable from "../namespaces/store.injectable";
import ingressStoreInjectable from "../network-ingresses/ingress-store.injectable";
import networkPolicyStoreInjectable from "../network-policies/store.injectable";
import serviceStoreInjectable from "../network-services/store.injectable";
import persistentVolumeClaimStoreInjectable from "../storage-volume-claims/store.injectable";
import cronJobStoreInjectable from "../workloads-cronjobs/store.injectable";
import daemonSetStoreInjectable from "../workloads-daemonsets/store.injectable";
import deploymentStoreInjectable from "../workloads-deployments/store.injectable";
import jobStoreInjectable from "../workloads-jobs/store.injectable";
import podStoreInjectable from "../workloads-pods/store.injectable";
import replicaSetStoreInjectable from "../workloads-replicasets/store.injectable";
import statefulSetStoreInjectable from "../workloads-statefulsets/store.injectable";
import topologyApisixKeysStorageInjectable from "./apisix-keys-storage.injectable";
import styles from "./topology.module.scss";
import {
  buildOverview,
  buildTopology,
  createReferenceFinder,
  findApisixAdmins,
  focusTopology,
  layoutTopology,
  parseApisixRoutes,
  pathOf,
} from "./topology-model";

import type { KubeJsonApi } from "@freelensapp/kube-api";
import type { KubeObject } from "@freelensapp/kube-object";

import type { ApiManager } from "../../../common/k8s-api/api-manager";
import type { ClusterContext } from "../../cluster-frame-context/cluster-frame-context";
import type { SubscribableStore, SubscribeStores } from "../../kube-watch-api/kube-watch-api";
import type { StorageLayer } from "../../utils/storage-helper";
import type { CustomResourceDefinitionStore } from "../custom-resource-definitions/store";
import type { ShowDetails } from "../kube-detail-params/show-details.injectable";
import type { NamespaceStore } from "../namespaces/store";
import type {
  ApisixInstance,
  LaidOutNode,
  RawObject,
  TopologyEdge,
  TopologyGraph,
  TopologyInput,
  TopologyMode,
} from "./topology-model";

type TopologyStore = SubscribableStore & { readonly items: KubeObject[]; readonly isLoaded: boolean };
type CoreKey = Exclude<keyof TopologyInput, "gateways" | "virtualServices" | "apisix">;
type IstioKey = "gateways" | "virtualServices";

interface Dependencies {
  subscribeStores: SubscribeStores;
  showDetails: ShowDetails;
  clusterContext: ClusterContext;
  apiManager: ApiManager;
  customResourceDefinitionStore: CustomResourceDefinitionStore;
  namespaceStore: NamespaceStore;
  apiKube: KubeJsonApi;
  apisixKeys: StorageLayer<Record<string, string>>;
  stores: Record<CoreKey, TopologyStore>;
}

interface ApisixStatus {
  routes?: number;
  error?: string;
}

const ISTIO_RESOURCES: Record<IstioKey, string> = { gateways: "gateways", virtualServices: "virtualservices" };
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;
const statusClass: Record<string, string> = { ok: "", warn: styles.warn, err: styles.err, idle: styles.idle };
const round = (value: number) => Math.round(value * 10) / 10;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const listSummary = (items: string[]) => (items.length > 1 ? `${items[0]} +${items.length - 1}` : (items[0] ?? ""));

// KubeObjects are replaced, not changed, on every update, so their plain copies can be kept.
const rawCopies = new WeakMap<KubeObject, RawObject>();

function toRaw(object: KubeObject): RawObject {
  let raw = rawCopies.get(object);

  if (!raw) {
    const plain = object.toPlainObject() as unknown as RawObject;

    raw = { ...plain, metadata: { ...plain.metadata, selfLink: object.selfLink } };
    rawCopies.set(object, raw);
  }

  return raw;
}

function podSelfLink(namespace: string, name: string) {
  return `/api/v1/namespaces/${namespace}/pods/${name}`;
}

/** A point on the cubic Bézier from p0 to p3 with control points p1, p2. */
function bezierAt(t: number, p0: number, p1: number, p2: number, p3: number) {
  const u = 1 - t;

  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

interface EdgeGeometry {
  edge: TopologyEdge;
  x: [number, number, number, number];
  y: [number, number, number, number];
}

@observer
class NonInjectedTopology extends React.Component<Dependencies> {
  // mobx-react 9 forbids reading this.props inside a derivation; everything here comes from DI and never changes.
  private readonly deps: Dependencies;
  private readonly findReferences = createReferenceFinder();
  private canvas: HTMLDivElement | null = null;
  private readonly disposers: (() => void)[] = [];
  private disposeWatch?: () => void;
  private drag?: { x: number; y: number; panX: number; panY: number; moved: boolean };

  @observable accessor mode: TopologyMode;
  @observable accessor selected: string | undefined = undefined;
  @observable accessor showRoutes = true;
  @observable accessor showCalls = true;
  @observable accessor zoom = 1;
  @observable accessor panX = 0;
  @observable accessor panY = 0;
  @observable accessor dragging = false;
  // Boxes that hold their value as is: the input is large and must not be made deeply observable.
  private readonly istioStoresBox = observable.box<Partial<Record<IstioKey, TopologyStore>>>({}, { deep: false });
  private readonly inputBox = observable.box<TopologyInput | undefined>(undefined, { deep: false });

  get istioStores() {
    return this.istioStoresBox.get();
  }

  get input() {
    return this.inputBox.get();
  }

  // APISIX keeps its routes in etcd; they are read from its Admin API, once a key is given.
  private readonly apisixBox = observable.box<ApisixInstance[]>([], { deep: false });
  @observable accessor apisixStatus: Record<string, ApisixStatus> = {};
  @observable accessor apisixPanelOpen = false;
  @observable accessor apisixDrafts: Record<string, string> = {};

  constructor(props: Dependencies) {
    super(props);
    this.deps = props;
    this.mode = props.clusterContext.hasSelectedAll ? "overview" : "architecture";
  }

  componentDidMount() {
    const { subscribeStores, clusterContext, apiManager, customResourceDefinitionStore } = this.deps;

    // Istio is optional: its resources are read when its CRDs are there.
    this.disposers.push(
      subscribeStores([customResourceDefinitionStore]),
      reaction(
        () =>
          Object.entries(ISTIO_RESOURCES)
            .map(([key, plural]) => {
              const crd = customResourceDefinitionStore.getByGroup("networking.istio.io", plural);

              return crd ? `${key}=${crd.getResourceApiBase()}` : "";
            })
            .filter(Boolean)
            .join(","),
        (found) => {
          const stores: Partial<Record<IstioKey, TopologyStore>> = {};

          for (const entry of found ? found.split(",") : []) {
            const [key, apiBase] = entry.split("=");
            const store = apiManager.getStore(apiBase);

            if (store) {
              stores[key as IstioKey] = store as unknown as TopologyStore;
            }
          }

          this.istioStoresBox.set(stores);
        },
        { fireImmediately: true },
      ),
      // Links cross namespaces, so every namespace is loaded, whatever the namespace filter says.
      reaction(
        () => [clusterContext.allNamespaces.join(","), Object.keys(this.istioStores).join(",")],
        () => {
          this.disposeWatch?.();
          this.disposeWatch = undefined;

          if (clusterContext.allNamespaces.length > 0) {
            this.disposeWatch = subscribeStores(
              [...Object.values(this.deps.stores), ...Object.values(this.istioStores)] as TopologyStore[],
              { namespaces: [...clusterContext.allNamespaces] },
            );
          }
        },
        { fireImmediately: true },
      ),
      reaction(
        () => JSON.stringify([this.apisixAdmins, this.deps.apisixKeys.get()]),
        () => void this.loadApisix(),
        { fireImmediately: true, delay: 500 },
      ),
      // Pods change all the time; redraw at most a few times a second.
      reaction(
        () => this.readInput(),
        (input) => this.inputBox.set(input),
        { fireImmediately: true, delay: 300 },
      ),
      // Re-fit when what is drawn changes shape: another namespace, another view.
      reaction(
        () => `${this.mode}:${this.focus?.join(",") ?? "*"}:${this.graph.nodes.length > 0}`,
        () => requestAnimationFrame(() => this.fit("width")),
        { fireImmediately: true },
      ),
    );

    // Routes change outside Kubernetes, so nothing announces them: read them again every minute.
    const timer = setInterval(() => void this.loadApisix(), 60_000);

    this.disposers.push(() => clearInterval(timer));
  }

  componentWillUnmount() {
    this.setCanvas(null);
    this.disposeWatch?.();
    this.disposers.forEach((dispose) => dispose());
  }

  readInput(): TopologyInput {
    const { stores } = this.deps;
    const read = (store: TopologyStore | undefined) => (store ? store.items.map(toRaw) : []);

    return {
      ingresses: read(stores.ingresses),
      services: read(stores.services),
      deployments: read(stores.deployments),
      statefulSets: read(stores.statefulSets),
      daemonSets: read(stores.daemonSets),
      replicaSets: read(stores.replicaSets),
      cronJobs: read(stores.cronJobs),
      jobs: read(stores.jobs),
      pods: read(stores.pods),
      configMaps: read(stores.configMaps),
      persistentVolumeClaims: read(stores.persistentVolumeClaims),
      podDisruptionBudgets: read(stores.podDisruptionBudgets),
      networkPolicies: read(stores.networkPolicies),
      gateways: read(this.istioStores.gateways),
      virtualServices: read(this.istioStores.virtualServices),
      apisix: this.apisixBox.get(),
    };
  }

  @computed get apisixAdmins() {
    return findApisixAdmins(this.deps.stores.services.items.map(toRaw));
  }

  /**
   * Reads the routes of every APISIX instance that has a key, through the Kubernetes API's
   * service proxy. getResponse writes no log, so the key never lands in the console.
   */
  async loadApisix() {
    const keys = this.deps.apisixKeys.get();
    const instances: ApisixInstance[] = [];
    const status: Record<string, ApisixStatus> = {};

    await Promise.all(
      this.apisixAdmins.map(async (admin) => {
        const id = `${admin.namespace}/${admin.name}`;
        const key = keys[id];

        if (!key) {
          status[id] = {};

          return;
        }

        const get = async (what: string) => {
          const response = await this.deps.apiKube.getResponse(
            `/api/v1/namespaces/${admin.namespace}/services/${admin.name}:${admin.port}/proxy/apisix/admin/${what}`,
            undefined,
            { headers: { "X-API-KEY": key } },
          );

          if (response.status === 401) {
            throw new Error("APISIX refused the key.");
          }

          if (response.status === 403) {
            throw new Error(
              `Not allowed: APISIX refused the key, or you may not use services/proxy in ${admin.namespace}.`,
            );
          }

          if (!response.ok) {
            throw new Error(`The Admin API answered ${response.status}.`);
          }

          return response.json();
        };

        try {
          const [routes, upstreams, services] = await Promise.all([
            get("routes"),
            get("upstreams").catch(() => undefined),
            get("services").catch(() => undefined),
          ]);
          const parsed = parseApisixRoutes(routes, upstreams, services);

          instances.push({ namespace: admin.namespace, adminService: admin.name, routes: parsed });
          status[id] = { routes: parsed.length };
        } catch (error) {
          status[id] = { error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );

    runInAction(() => {
      this.apisixBox.set(instances);
      this.apisixStatus = status;
    });
  }

  @action
  saveApisixKey(id: string) {
    const key = this.apisixDrafts[id]?.trim();

    if (key) {
      this.deps.apisixKeys.merge({ [id]: key });
      this.apisixDrafts = { ...this.apisixDrafts, [id]: "" };
    }
  }

  @action
  forgetApisixKey(id: string) {
    const { [id]: _forgotten, ...rest } = this.deps.apisixKeys.get();

    this.deps.apisixKeys.set(rest);
  }

  @computed get isLoaded() {
    return Object.values(this.deps.stores).every((store) => store.isLoaded);
  }

  /** The selected namespaces, or undefined when all are selected. */
  @computed get focus(): string[] | undefined {
    const { clusterContext } = this.deps;

    return clusterContext.hasSelectedAll ? undefined : [...clusterContext.contextNamespaces];
  }

  @computed get fullGraph(): TopologyGraph | undefined {
    if (!this.input) {
      return undefined;
    }

    return buildTopology(this.input, this.mode === "architecture" ? "architecture" : "network", {
      findReferences: this.findReferences,
    });
  }

  @computed get graph(): TopologyGraph {
    const full = this.fullGraph;

    if (!full) {
      return { nodes: [], edges: [], hiddenCount: 0, collapsed: [], objectCounts: {} };
    }

    return this.mode === "overview" ? buildOverview(full) : focusTopology(full, this.focus);
  }

  @computed get visibleEdges(): TopologyEdge[] {
    return this.graph.edges.filter((edge) => (edge.type === "calls" ? this.showCalls : this.showRoutes));
  }

  @computed get layout() {
    return layoutTopology({ ...this.graph, edges: this.visibleEdges });
  }

  @computed get path() {
    return pathOf(this.visibleEdges, this.selected);
  }

  // ---------------------------------------------------------------- moving around

  /**
   * Zoom to fit, never above 100%. "width" fits the width only and stops at 60%, so text stays
   * readable and the rest is a drag away; "all" fits everything, down to 20%.
   */
  @action
  fit(what: "width" | "all" = "all") {
    const element = this.canvas;
    const { width, height } = this.layout;

    if (!element || width === 0) {
      return;
    }

    const byWidth = element.clientWidth / width;
    const scale = what === "width" ? byWidth : Math.min(byWidth, element.clientHeight / height);

    this.zoom = clamp(Math.floor(scale * 20) / 20, what === "width" ? 0.6 : MIN_ZOOM, 1);
    this.panX = Math.max(0, (element.clientWidth - width * this.zoom) / 2);
    this.panY = what === "width" ? 0 : Math.max(0, (element.clientHeight - height * this.zoom) / 2);
  }

  /** Zooms keeping the point (x, y) of the canvas where it is. */
  @action
  zoomAt(next: number, x: number, y: number) {
    const zoom = clamp(next, MIN_ZOOM, MAX_ZOOM);

    this.panX = x - ((x - this.panX) * zoom) / this.zoom;
    this.panY = y - ((y - this.panY) * zoom) / this.zoom;
    this.zoom = zoom;
  }

  zoomBy(factor: number) {
    const element = this.canvas;

    this.zoomAt(this.zoom * factor, (element?.clientWidth ?? 0) / 2, (element?.clientHeight ?? 0) / 2);
  }

  /**
   * A callback ref: the canvas can appear after componentDidMount (TabLayout renders its content
   * late), and wheel listeners must be added by hand to be allowed to preventDefault.
   */
  private readonly setCanvas = (element: HTMLDivElement | null) => {
    this.canvas?.removeEventListener("wheel", this.onWheel);
    this.canvas = element;
    element?.addEventListener("wheel", this.onWheel, { passive: false });
  };

  private readonly onWheel = (event: WheelEvent) => {
    const element = this.canvas;

    if (!element) {
      return;
    }

    event.preventDefault();

    const rect = element.getBoundingClientRect();
    // Pinch gestures arrive as wheel events with ctrlKey and small deltas.
    const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015));

    this.zoomAt(this.zoom * factor, event.clientX - rect.left, event.clientY - rect.top);
  };

  private readonly onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("button")) {
      return;
    }

    this.drag = { x: event.clientX, y: event.clientY, panX: this.panX, panY: this.panY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  private readonly onPointerMove = action((event: React.PointerEvent<HTMLDivElement>) => {
    const { drag } = this;

    if (!drag) {
      return;
    }

    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;

    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) {
      drag.moved = true;
      this.dragging = true;
    }

    if (drag.moved) {
      this.panX = drag.panX + dx;
      this.panY = drag.panY + dy;
    }
  });

  private readonly onPointerUp = action(() => {
    if (this.drag && !this.drag.moved) {
      this.selected = undefined; // a click on the empty canvas
    }

    this.drag = undefined;
    this.dragging = false;
  });

  // ---------------------------------------------------------------- actions

  @action
  setMode(mode: TopologyMode) {
    this.mode = mode;
    this.selected = undefined;
  }

  @action
  showNamespace(namespace: string, mode: TopologyMode = this.mode === "overview" ? "architecture" : this.mode) {
    this.deps.namespaceStore.selectSingle(namespace);
    this.setMode(mode);
  }

  @action
  addNamespace(namespace: string) {
    this.deps.namespaceStore.selectNamespaces([...(this.focus ?? []), namespace]);
  }

  // ---------------------------------------------------------------- drawing

  renderEdges(): { paths: React.ReactNode; labels: React.ReactNode } {
    const nodes = new Map(this.layout.nodes.map((n) => [n.id, n]));
    const outs = new Map<string, TopologyEdge[]>();
    const ins = new Map<string, TopologyEdge[]>();

    for (const edge of this.visibleEdges) {
      outs.set(edge.from, [...(outs.get(edge.from) ?? []), edge]);
      ins.set(edge.to, [...(ins.get(edge.to) ?? []), edge]);
    }

    const centre = (n: LaidOutNode) => n.y + n.height / 2;
    const port = (list: TopologyEdge[], edge: TopologyEdge, self: LaidOutNode, other: (e: TopologyEdge) => string) => {
      const sorted = [...list].sort(
        (a, b) => centre(nodes.get(other(a)) as LaidOutNode) - centre(nodes.get(other(b)) as LaidOutNode),
      );
      const index = sorted.indexOf(edge);

      return (
        centre(self) +
        (index - (sorted.length - 1) / 2) * Math.min(10, (self.height - 24) / Math.max(1, sorted.length - 1))
      );
    };
    const highlight = this.selected !== undefined;
    const geometries: EdgeGeometry[] = [];

    const paths = this.visibleEdges.map((edge) => {
      const from = nodes.get(edge.from);
      const to = nodes.get(edge.to);

      if (!from || !to) {
        return null;
      }

      const backwards = to.x <= from.x;
      const x1 = backwards ? from.x : from.x + from.width;
      const x2 = backwards ? to.x + to.width + 1 : to.x - 1;
      const y1 = port(outs.get(edge.from) ?? [], edge, from, (e) => e.to);
      const y2 = port(ins.get(edge.to) ?? [], edge, to, (e) => e.from);
      const head = backwards ? x2 + 7 : x2 - 7;
      const bend = Math.max(40, Math.abs(head - x1) / 2) * (backwards ? -1 : 1);
      const d = `M${x1} ${round(y1)}C${round(x1 + bend)} ${round(y1)} ${round(head - bend)} ${round(y2)} ${head} ${round(y2)}`;
      const arrow = `M${head} ${round(y2 - 4)}L${x2} ${round(y2)}L${head} ${round(y2 + 4)}Z`;
      const onPath = this.path.edges.has(edge.id);
      const className = [styles.edge, styles[edge.type], onPath ? styles.onPath : highlight ? styles.dimmed : ""].join(
        " ",
      );

      geometries.push({ edge, x: [x1, x1 + bend, head - bend, head], y: [y1, y1, y2, y2] });

      return (
        <g key={edge.id} className={className}>
          <path d={d} />
          <path d={arrow} className={styles.arrow} />
          <title>{`${edge.label}\n${edge.via}`}</title>
        </g>
      );
    });

    return { paths, labels: this.renderEdgeLabels(geometries) };
  }

  /**
   * One label per kind of link at each end: the calls into a Service share one label near it,
   * the edges a Service or route fans out to share one near the source.
   */
  renderEdgeLabels(geometries: EdgeGeometry[]) {
    const selected = this.selected !== undefined;

    if (this.zoom < 0.45 || (!selected && geometries.length > 160)) {
      return null;
    }

    const groups = new Map<string, EdgeGeometry[]>();

    for (const geometry of geometries) {
      const { edge } = geometry;

      if (!edge.label || (selected && !this.path.edges.has(edge.id))) {
        continue;
      }

      const key = edge.type === "calls" ? `in:${edge.to}:${edge.label}` : `out:${edge.from}:${edge.label}`;

      groups.set(key, [...(groups.get(key) ?? []), geometry]);
    }

    return [...groups.entries()].map(([key, members]) => {
      const { edge, x, y } = [...members].sort((a, b) => a.y[3] - b.y[3])[Math.floor((members.length - 1) / 2)];
      const t = members.length === 1 ? 0.5 : edge.type === "calls" ? 0.75 : 0.3;
      const text = members.length > 1 ? `${edge.label} ×${members.length}` : edge.label;

      return (
        <text
          key={key}
          className={`${styles.edgeLabel} ${styles[edge.type]}`}
          x={round(bezierAt(t, ...x))}
          y={round(bezierAt(t, ...y) - 5)}
          textAnchor="middle"
        >
          {text}
        </text>
      );
    });
  }

  renderNode(node: LaidOutNode) {
    const selected = this.selected === node.id;
    const dimmed = this.selected !== undefined && !this.path.nodes.has(node.id);
    const focused = this.mode === "overview" && this.focus?.includes(node.namespace);
    const className = [
      styles.node,
      statusClass[node.status],
      selected ? styles.selected : "",
      dimmed ? styles.dimmed : "",
      node.outsideView ? styles.outsideView : "",
      focused ? styles.focused : "",
    ].join(" ");
    const maxPods = node.kind === "Namespace" ? 16 : 12;

    return (
      <button
        key={node.id}
        type="button"
        className={className}
        style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
        onClick={() => (this.selected = selected ? undefined : node.id)}
        onDoubleClick={() => node.kind === "Namespace" && this.showNamespace(node.name, "architecture")}
        data-testid={`topology-node-${node.id}`}
      >
        <span className={styles.nodeHead}>
          <span className={styles.kind}>
            {node.kind}
            {node.outsideView && node.namespace ? ` · ${node.namespace}` : ""}
          </span>
          {node.flags.slice(0, 2).map((flag) => (
            <span key={flag.text} className={styles.flag} title={flag.detail}>
              {flag.text}
            </span>
          ))}
        </span>
        <span className={styles.name}>{node.name}</span>
        <span className={styles.summary}>
          {node.summary}
          {node.kind !== "Pod" && node.pods.length > 0 && (
            <span className={styles.pods}>
              {node.pods.slice(0, maxPods).map((pod) => (
                <span
                  key={pod.name}
                  className={`${styles.pod} ${statusClass[pod.status]}`}
                  title={`${pod.name}: ${pod.reason}`}
                />
              ))}
              {node.pods.length > maxPods && <span className={styles.more}>+{node.pods.length - maxPods}</span>}
            </span>
          )}
        </span>
        {node.kind === "Namespace" && node.hosts.length > 0 && (
          <span className={styles.hosts} title={node.hosts.join("\n")}>
            {listSummary(node.hosts)}
          </span>
        )}
        {node.attachments.length > 0 && (
          <span className={styles.attachments}>
            {[...new Set(node.attachments.map((a) => a.short))].map((short) => (
              <span
                key={short}
                className={styles.attachment}
                title={node.attachments
                  .filter((a) => a.short === short)
                  .map((a) => `${a.kind} ${a.name}`)
                  .join("\n")}
              >
                {short}
              </span>
            ))}
          </span>
        )}
      </button>
    );
  }

  renderDetails() {
    const node = this.graph.nodes.find((n) => n.id === this.selected);

    if (!node) {
      // No panel until something is selected: the map gets the full width.
      return null;
    }

    const byId = (id: string) => this.graph.nodes.find((n) => n.id === id);
    const incoming = this.visibleEdges.filter((e) => e.to === node.id);
    const outgoing = this.visibleEdges.filter((e) => e.from === node.id);
    const edgeRow = (edge: TopologyEdge, otherId: string) => {
      const other = byId(otherId);

      return (
        <li key={edge.id} className={edge.inferred ? styles.inferred : ""}>
          <span className={styles.rowName}>
            {other
              ? `${other.namespace && other.namespace !== node.namespace && other.kind !== "Namespace" ? `${other.namespace}/` : ""}${other.name}`
              : otherId}
          </span>
          {edge.via.split("\n").map((line) => (
            <span key={line} className={styles.rowVia} title={line}>
              {line}
            </span>
          ))}
          <span className={styles.rowKind}>{edge.label}</span>
        </li>
      );
    };
    const isNamespace = node.kind === "Namespace";

    return (
      <aside className={styles.details}>
        <header>
          <span className={styles.kind}>{node.kind}</span>
          <h2>{node.name}</h2>
          <span className={styles.summary}>
            {[isNamespace ? "" : node.namespace, node.summary].filter(Boolean).join(" · ")}
          </span>
        </header>
        {node.flags.map((flag) => (
          <p key={flag.text} className={styles.note}>
            {flag.detail}
          </p>
        ))}
        {node.outsideView && node.namespace && (
          <div className={styles.outsideNote}>
            <p>
              In namespace <b>{node.namespace}</b>, outside the selection. It is shown because it is linked to it.
            </p>
            <div className={styles.actions}>
              <button type="button" onClick={() => this.showNamespace(node.namespace)}>
                Show {node.namespace}
              </button>
              <button type="button" onClick={() => this.addNamespace(node.namespace)}>
                Add to the view
              </button>
            </div>
          </div>
        )}
        {isNamespace && (
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primary}
              onClick={() => this.showNamespace(node.name, "architecture")}
            >
              Open architecture
            </button>
            <button type="button" onClick={() => this.showNamespace(node.name, "network")}>
              Network flow
            </button>
          </div>
        )}
        {node.hosts.length > 0 && (
          <section>
            <h3>Hosts</h3>
            <ul>
              {node.hosts.map((host) => (
                <li key={host}>
                  <span className={styles.rowName}>{host}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {incoming.length > 0 && (
          <section>
            <h3>{isNamespace ? "Linked from" : "Reached from"}</h3>
            <ul>{incoming.map((e) => edgeRow(e, e.from))}</ul>
          </section>
        )}
        {outgoing.length > 0 && (
          <section>
            <h3>
              {isNamespace ? "Links to" : node.kind === "Service" || node.kind === "External" ? "Sends to" : "Talks to"}
            </h3>
            <ul>{outgoing.map((e) => edgeRow(e, e.to))}</ul>
          </section>
        )}
        {node.attachments.length > 0 && (
          <section>
            <h3>Attached</h3>
            <ul>
              {node.attachments.map((a) => (
                <li key={`${a.kind}/${a.name}`}>
                  <span className={styles.rowName}>{a.name}</span>
                  <span className={styles.rowKind}>{a.kind}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {!isNamespace && node.kind !== "Pod" && node.pods.length > 0 && (
          <section>
            <h3>Pods</h3>
            <ul>
              {node.pods.map((pod) => (
                <li key={pod.name}>
                  <button
                    type="button"
                    className={styles.linkRow}
                    onClick={() => this.deps.showDetails(podSelfLink(node.namespace, pod.name))}
                  >
                    <span className={`${styles.pod} ${statusClass[pod.status]}`} />
                    <span className={styles.rowName}>{pod.name}</span>
                    <span className={styles.rowVia}>{pod.reason}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {node.selfLink && !isNamespace && (
          <button type="button" className={styles.primary} onClick={() => this.deps.showDetails(node.selfLink)}>
            Open details
          </button>
        )}
      </aside>
    );
  }

  get apisixSummary() {
    const statuses = Object.values(this.apisixStatus);
    const routes = statuses.reduce((sum, status) => sum + (status.routes ?? 0), 0);

    if (statuses.some((status) => status.error)) {
      return "error";
    }

    return statuses.some((status) => status.routes !== undefined) ? `${routes} routes` : "add a key";
  }

  renderApisixPanel() {
    const keys = this.deps.apisixKeys.get();

    return (
      <div className={styles.apisixPanel} data-testid="topology-apisix-panel">
        <p>
          APISIX keeps its routes in etcd, not in Kubernetes, so Topology reads them from its Admin API, through the
          Kubernetes API (services/proxy). Use a key with the <b>viewer</b> role: it can only read. The key is kept for
          this cluster, on this computer.
        </p>
        {this.apisixAdmins.map((admin) => {
          const id = `${admin.namespace}/${admin.name}`;
          const status = this.apisixStatus[id] ?? {};

          return (
            <form
              key={id}
              className={styles.apisixRow}
              onSubmit={(event) => {
                event.preventDefault();
                this.saveApisixKey(id);
              }}
            >
              <span className={styles.rowName}>{id}</span>
              <input
                type="password"
                autoComplete="off"
                aria-label={`Admin API key for ${id}`}
                placeholder={keys[id] ? "Key saved · type to replace" : "Viewer key"}
                value={this.apisixDrafts[id] ?? ""}
                onChange={(event) => (this.apisixDrafts = { ...this.apisixDrafts, [id]: event.target.value })}
              />
              <button type="submit">Save</button>
              {keys[id] && (
                <button type="button" onClick={() => this.forgetApisixKey(id)}>
                  Forget
                </button>
              )}
              <span className={status.error ? styles.apisixError : styles.rowVia}>
                {status.error ?? (status.routes !== undefined ? `${status.routes} routes read` : "")}
              </span>
            </form>
          );
        })}
      </div>
    );
  }

  renderCount() {
    const { graph, mode } = this;
    const hint = this.selected
      ? ""
      : mode === "overview"
        ? " · click a namespace to see its links"
        : " · click an item to trace its path";

    if (mode === "overview") {
      const namespaces = graph.nodes.filter((n) => n.kind === "Namespace").length;

      return `${namespaces} namespaces · ${graph.edges.length} links between them${hint}`;
    }

    const outside = graph.nodes.filter((n) => n.outsideView).length;

    return [
      `${graph.nodes.length - outside} shown`,
      mode === "architecture" && graph.hiddenCount > 0 ? `${graph.hiddenCount} folded into cards` : "",
      outside > 0 ? `${outside} linked from other namespaces` : "",
    ]
      .filter(Boolean)
      .join(" · ")
      .concat(hint);
  }

  renderCanvas() {
    const { layout, graph } = this;

    if (graph.nodes.length === 0) {
      return (
        <p className={styles.empty}>
          {!this.input || !this.isLoaded ? "Loading the cluster…" : "Nothing to draw in the selected namespaces."}
        </p>
      );
    }

    const edges = this.renderEdges();

    return (
      <div
        className={styles.scaled}
        style={{
          width: layout.width,
          height: layout.height,
          transform: `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`,
        }}
      >
        {layout.groups.map((group) => (
          <div
            key={group.id}
            className={`${styles.group} ${group.outsideView ? styles.outsideGroup : ""}`}
            style={{ left: group.x, top: group.y, width: group.width, height: group.height }}
          >
            <span className={styles.groupLabel}>{group.label}</span>
            <span className={styles.groupMeta}>{group.meta}</span>
          </div>
        ))}
        <svg className={styles.edges} width={layout.width} height={layout.height} aria-hidden="true">
          {edges.paths}
        </svg>
        {layout.nodes.map((node) => this.renderNode(node))}
        {/* Labels go over the cards, so a label that reaches into a card stays readable. */}
        <svg className={styles.edges} width={layout.width} height={layout.height} aria-hidden="true">
          {edges.labels}
        </svg>
      </div>
    );
  }

  render() {
    const { graph, mode } = this;

    return (
      <TabLayout>
        <div className={styles.topology} data-testid="topology-page">
          <div className={styles.header}>
            <h5>Topology</h5>
            <span className={styles.count}>{this.renderCount()}</span>
            <NamespaceSelectFilter id="topology-namespace-select-filter-input" />
          </div>
          <div className={styles.toolbar}>
            <div className={styles.segmented} role="radiogroup" aria-label="View">
              {(["overview", "architecture", "network"] as const).map((each) => (
                <button
                  key={each}
                  type="button"
                  role="radio"
                  aria-checked={mode === each}
                  className={mode === each ? styles.active : ""}
                  onClick={() => this.setMode(each)}
                >
                  {{ overview: "Overview", architecture: "Architecture", network: "Network flow" }[each]}
                </button>
              ))}
            </div>
            <button
              type="button"
              aria-pressed={this.showRoutes}
              className={`${styles.toggle} ${this.showRoutes ? styles.active : ""}`}
              onClick={() => (this.showRoutes = !this.showRoutes)}
            >
              <span className={styles.legendRoutes} />
              routes · exposes
            </button>
            <button
              type="button"
              aria-pressed={this.showCalls}
              className={`${styles.toggle} ${this.showCalls ? styles.active : ""}`}
              onClick={() => (this.showCalls = !this.showCalls)}
            >
              <span className={styles.legendCalls} />
              calls · from config
            </button>
            {this.apisixAdmins.length > 0 && (
              <button
                type="button"
                aria-expanded={this.apisixPanelOpen}
                className={`${styles.toggle} ${this.apisixBox.get().length > 0 ? styles.active : ""}`}
                onClick={() => (this.apisixPanelOpen = !this.apisixPanelOpen)}
                data-testid="topology-apisix-toggle"
              >
                APISIX · {this.apisixSummary}
              </button>
            )}
            <div className={styles.grow} />
            <div className={styles.zoom}>
              <button type="button" aria-label="Zoom out" onClick={() => this.zoomBy(1 / 1.2)}>
                −
              </button>
              <span>{Math.round(this.zoom * 100)}%</span>
              <button type="button" aria-label="Zoom in" onClick={() => this.zoomBy(1.2)}>
                +
              </button>
              <button type="button" className={styles.fit} onClick={() => this.fit()}>
                Fit
              </button>
            </div>
          </div>
          {this.apisixPanelOpen && this.renderApisixPanel()}
          {mode !== "overview" && graph.nodes.length > 150 && (
            <p className={styles.crowded}>
              {graph.nodes.length} items is a lot to read at once. Use Overview to see how namespaces link up, or pick
              one or two namespaces to see how a tool is put together.
            </p>
          )}
          <div className={styles.body}>
            <div
              ref={this.setCanvas}
              className={`${styles.canvas} ${this.dragging ? styles.dragging : ""}`}
              onPointerDown={this.onPointerDown}
              onPointerMove={this.onPointerMove}
              onPointerUp={this.onPointerUp}
              onPointerCancel={this.onPointerUp}
              role="presentation"
              data-testid="topology-canvas"
            >
              {this.renderCanvas()}
              <span className={styles.canvasHint}>scroll to zoom · drag to move</span>
            </div>
            {this.renderDetails()}
          </div>
        </div>
      </TabLayout>
    );
  }
}

export const Topology = withInjectables<Dependencies>(NonInjectedTopology, {
  getProps: (di, props) => ({
    ...props,
    subscribeStores: di.inject(subscribeStoresInjectable),
    showDetails: di.inject(showDetailsInjectable),
    clusterContext: di.inject(clusterFrameContextForNamespacedResourcesInjectable),
    apiManager: di.inject(apiManagerInjectable),
    customResourceDefinitionStore: di.inject(customResourceDefinitionStoreInjectable),
    namespaceStore: di.inject(namespaceStoreInjectable),
    apiKube: di.inject(apiKubeInjectable),
    apisixKeys: di.inject(topologyApisixKeysStorageInjectable),
    stores: {
      ingresses: di.inject(ingressStoreInjectable),
      services: di.inject(serviceStoreInjectable),
      deployments: di.inject(deploymentStoreInjectable),
      statefulSets: di.inject(statefulSetStoreInjectable),
      daemonSets: di.inject(daemonSetStoreInjectable),
      replicaSets: di.inject(replicaSetStoreInjectable),
      cronJobs: di.inject(cronJobStoreInjectable),
      jobs: di.inject(jobStoreInjectable),
      pods: di.inject(podStoreInjectable),
      configMaps: di.inject(configMapStoreInjectable),
      persistentVolumeClaims: di.inject(persistentVolumeClaimStoreInjectable),
      podDisruptionBudgets: di.inject(podDisruptionBudgetStoreInjectable),
      networkPolicies: di.inject(networkPolicyStoreInjectable),
    },
  }),
});
