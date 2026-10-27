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
import { KubeObjectMenu } from "../kube-object-menu";
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
import { apisixKeysOf, readApisix } from "./apisix-admin";
import topologyApisixKeysStorageInjectable from "./apisix-keys-storage.injectable";
import { edgeGeometry, exportTopologyPng, roundedSvgPath } from "./export-image";
import styles from "./topology.module.scss";
import {
  buildOverview,
  buildTopology,
  compactSizeOf,
  createReferenceFinder,
  findApisixAdmins,
  focusTopology,
  layoutTopology,
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
import type { MenuControls } from "../menu";
import type { NamespaceStore } from "../namespaces/store";
import type { ApisixKey, ApisixStatus } from "./apisix-admin";
import type {
  ApisixInstance,
  LaidOutNode,
  Point,
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

/** A short fingerprint of a key, so a reaction can notice a new key without holding the key itself. */
function fingerprint(text: string | undefined): number {
  let hash = 5381;

  for (const char of text ?? "") {
    hash = ((hash << 5) + hash + char.charCodeAt(0)) | 0;
  }

  return hash;
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

const ARROW = 7;
const roundedPath = roundedSvgPath;

/** Labels are short: the full text is in the tooltip and the details panel. */
const shortLabel = (label: string) => (label.length > 22 ? `${label.slice(0, 21)}…` : label);

@observer
class NonInjectedTopology extends React.Component<Dependencies> {
  // mobx-react 9 forbids reading this.props inside a derivation; everything here comes from DI and never changes.
  private readonly deps: Dependencies;
  private readonly findReferences = createReferenceFinder();
  private canvas: HTMLDivElement | null = null;
  private readonly disposers: (() => void)[] = [];
  private disposeWatch?: () => void;
  private drag?: { x: number; y: number; panX: number; panY: number; moved: boolean };
  private userMoved = false;
  private menuControls = new Map<string, MenuControls>();

  @observable accessor mode: TopologyMode;
  @observable accessor selected: string | undefined = undefined;
  @observable accessor showRoutes = true;
  @observable accessor showCalls = true;
  @observable accessor density: "standard" | "compact" = "standard";
  @observable accessor searchQuery = "";
  @observable accessor searchOpen = false;
  private searchInputRef: HTMLInputElement | null = null;
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
  @observable accessor apisixPanelOpen = true;
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

              const apiBase = crd?.getResourceApiBase();

              // The API of a CRD is registered a little after the CRD is loaded: wait for it.
              return apiBase ? `${key}=${apiBase}=${apiManager.getApi(apiBase) ? "ready" : "waiting"}` : "";
            })
            .filter(Boolean)
            .join(","),
        (found) => {
          const stores: Partial<Record<IstioKey, TopologyStore>> = {};

          for (const entry of found ? found.split(",") : []) {
            const [key, apiBase, ready] = entry.split("=");
            const store = ready === "ready" ? apiManager.getStore(apiBase) : undefined;

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
        () =>
          JSON.stringify([
            this.apisixAdmins,
            Object.entries(this.apisixKeys).map(([id, { key, source }]) => [id, source, fingerprint(key)]),
          ]),
        () => void this.loadApisix(),
        { fireImmediately: true, delay: 500 },
      ),
      // Pods change all the time; redraw at most a few times a second.
      reaction(
        () => this.readInput(),
        (input) => this.inputBox.set(input),
        { fireImmediately: true, delay: 300 },
      ),
      // Fit again for another namespace or another view, and while what is drawn grows as the
      // cluster loads, until the user zooms or moves the map.
      reaction(
        () => `${this.mode}:${this.focus?.join(",") ?? "*"}`,
        () => {
          this.userMoved = false;
          requestAnimationFrame(() => this.fit("width"));
        },
        { fireImmediately: true },
      ),
      reaction(
        () => `${Math.round(this.layout.width / 50)}x${Math.round(this.layout.height / 50)}`,
        () => !this.userMoved && requestAnimationFrame(() => this.fit("width")),
      ),
    );

    // Routes change outside Kubernetes, so nothing announces them: read them again every minute.
    const timer = setInterval(() => void this.loadApisix(), 60_000);

    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        runInAction(() => {
          this.searchOpen = true;
        });
        setTimeout(() => this.searchInputRef?.focus(), 50);
      } else if (e.key === "Escape" && this.searchOpen) {
        runInAction(() => {
          this.searchQuery = "";
          this.searchOpen = false;
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);

    this.disposers.push(() => {
      clearInterval(timer);
      window.removeEventListener("keydown", onKeyDown);
    });
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
   * The key for each APISIX: one entered in the panel, else the viewer key found in its
   * ConfigMap, read with the user's own access. Never an admin key.
   */
  @computed get apisixKeys(): Record<string, ApisixKey> {
    return apisixKeysOf(
      this.deps.stores.services.items.map(toRaw),
      this.deps.stores.configMaps.items.map(toRaw),
      this.deps.apisixKeys.get(),
    );
  }

  async loadApisix() {
    const { instances, status } = await readApisix(
      this.deps.apiKube,
      this.deps.stores.services.items.map(toRaw),
      this.apisixKeys,
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
    return layoutTopology(
      { ...this.graph, edges: this.visibleEdges },
      this.density === "compact" ? { size: compactSizeOf } : undefined,
    );
  }

  @computed get searchMatchIds(): Set<string> {
    const q = this.searchQuery.trim().toLowerCase();

    if (!q) {
      return new Set();
    }

    const matched = new Set<string>();

    for (const node of this.graph.nodes) {
      if (
        node.name.toLowerCase().includes(q) ||
        node.kind.toLowerCase().includes(q) ||
        (node.namespace && node.namespace.toLowerCase().includes(q))
      ) {
        matched.add(node.id);
      }
    }

    return matched;
  }

  @computed get path() {
    return pathOf(this.visibleEdges, this.selected);
  }

  // ---------------------------------------------------------------- moving around

  /**
   * Zoom to fit, never above 100%. "width" fits the width only and stops at 45%, so text stays
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

    this.zoom = clamp(Math.floor(scale * 20) / 20, what === "width" ? 0.45 : MIN_ZOOM, 1);
    this.panX = Math.max(0, (element.clientWidth - width * this.zoom) / 2);
    this.panY =
      what === "width" && height * this.zoom > element.clientHeight
        ? 0
        : Math.max(0, (element.clientHeight - height * this.zoom) / 2);
  }

  exportImage() {
    const ns = this.focus?.length ? this.focus.join("-") : "all-namespaces";

    exportTopologyPng({
      element: this.canvas,
      layout: this.layout,
      edges: this.visibleEdges,
      selected: this.selected,
      path: this.path,
      filename: `topology-${this.mode}-${ns}.png`,
    });
  }

  /** Zooms keeping the point (x, y) of the canvas where it is. */
  @action
  zoomAt(next: number, x: number, y: number) {
    const zoom = clamp(next, MIN_ZOOM, MAX_ZOOM);

    this.panX = x - ((x - this.panX) * zoom) / this.zoom;
    this.panY = y - ((y - this.panY) * zoom) / this.zoom;
    this.zoom = zoom;
    this.userMoved = true;
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
      this.userMoved = true;
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
    const { routes } = this.layout;
    const highlight = this.selected !== undefined;
    const drawn = this.visibleEdges.filter((edge) => (routes[edge.id]?.length ?? 0) >= 2);

    const paths = drawn.map((edge) => {
      const { line, arrow } = edgeGeometry(routes[edge.id]);
      const onPath = this.path.edges.has(edge.id);
      const className = [styles.edge, styles[edge.type], onPath ? styles.onPath : highlight ? styles.dimmed : ""].join(
        " ",
      );

      return (
        <g key={edge.id} className={className}>
          <path d={roundedPath(line)} />
          <path d={arrow} className={styles.arrow} />
          <title>{`${edge.label}\n${edge.via}`}</title>
        </g>
      );
    });

    return { paths, labels: this.renderEdgeLabels(drawn) };
  }

  /**
   * One label per kind of link at each end, on the straight run there: the calls into a Service
   * run together into it and share one label before its arrow; what a Service or route fans out
   * to shares one label as it leaves.
   */
  renderEdgeLabels(edges: TopologyEdge[]) {
    const selected = this.selected !== undefined;

    if (this.zoom < 0.45 || (!selected && edges.length > 200)) {
      return null;
    }

    const { routes } = this.layout;
    const groups = new Map<string, TopologyEdge[]>();
    // A source whose lines carry different labels can't put them all where it starts: they would
    // sit on each other, so each goes by its target instead.
    const labelsOut = new Map<string, Set<string>>();

    for (const edge of edges) {
      if (edge.type !== "calls" && edge.label) {
        labelsOut.set(edge.from, (labelsOut.get(edge.from) ?? new Set<string>()).add(edge.label));
      }
    }

    const byTarget = (edge: TopologyEdge) => edge.type === "calls" || (labelsOut.get(edge.from)?.size ?? 0) > 1;

    for (const edge of edges) {
      if (!edge.label || (selected && !this.path.edges.has(edge.id))) {
        continue;
      }

      const key = byTarget(edge) ? `in:${edge.to}:${edge.label}` : `out:${edge.from}:${edge.label}`;

      groups.set(key, [...(groups.get(key) ?? []), edge]);
    }

    return [...groups.entries()].map(([key, members]) => {
      const edge = members[0];
      const points = routes[edge.id];
      const atEnd = byTarget(edge);
      const anchor = (atEnd ? points.at(-1) : points.at(0)) as Point;
      const neighbour = (atEnd ? points.at(-2) : points.at(1)) as Point;
      const vertical = Math.abs(anchor.y - neighbour.y) > Math.abs(anchor.x - neighbour.x);
      const rightwards = atEnd ? anchor.x >= neighbour.x : neighbour.x >= anchor.x;
      const x = vertical
        ? anchor.x + 8
        : atEnd
          ? anchor.x - (ARROW + 4) * (rightwards ? 1 : -1)
          : anchor.x + 6 * (rightwards ? 1 : -1);
      const y = vertical ? (anchor.y + neighbour.y) / 2 + 3 : anchor.y - 6;
      const text = members.length > 1 ? `${shortLabel(edge.label)} ×${members.length}` : shortLabel(edge.label);

      return (
        <text
          key={key}
          className={`${styles.edgeLabel} ${styles[edge.type]}`}
          x={round(x)}
          y={round(y)}
          textAnchor={vertical ? "start" : atEnd === rightwards ? "end" : "start"}
        >
          {text}
        </text>
      );
    });
  }

  getKubeObject(node: LaidOutNode): KubeObject | undefined {
    if (!node.selfLink) {
      return undefined;
    }

    return this.deps.apiManager.getStore(node.selfLink)?.getByPath(node.selfLink);
  }

  renderFocusHud() {
    if (!this.selected) {
      return null;
    }

    const node = this.graph.nodes.find((n) => n.id === this.selected);

    if (!node) {
      return null;
    }

    return (
      <div className={styles.focusHud} data-testid="topology-focus-hud">
        <span className={styles.focusBadge}>FOCUS MODE</span>
        <span className={styles.focusTarget}>
          <strong>{node.kind}</strong> {node.namespace && node.kind !== "Namespace" ? `${node.namespace}/` : ""}
          {node.name}
        </span>
        <span className={styles.focusStats}>
          <span className={styles.statUpstream}>↑ {this.path.upstream.size} Inbound</span>
          <span className={styles.statDownstream}>↓ {this.path.downstream.size} Outbound</span>
        </span>
        <button
          type="button"
          className={styles.exitFocusBtn}
          onClick={() => {
            this.selected = undefined;
          }}
          title="Exit Focus Mode"
        >
          ✕ Exit Focus
        </button>
      </div>
    );
  }

  renderSearchHud() {
    if (!this.searchOpen) {
      return null;
    }

    return (
      <div className={styles.searchHud} data-testid="topology-search-hud">
        <span className={styles.searchIcon}>🔍</span>
        <input
          ref={(el) => {
            this.searchInputRef = el;
          }}
          type="text"
          placeholder="Filter nodes (Ctrl+F)..."
          value={this.searchQuery}
          onChange={(e) => (this.searchQuery = e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              this.searchQuery = "";
              this.searchOpen = false;
            }
          }}
        />
        {this.searchQuery && (
          <span className={styles.searchCount}>
            {this.searchMatchIds.size} {this.searchMatchIds.size === 1 ? "match" : "matches"}
          </span>
        )}
        <button
          type="button"
          className={styles.closeSearchBtn}
          onClick={() => {
            this.searchQuery = "";
            this.searchOpen = false;
          }}
          title="Close search"
        >
          ✕
        </button>
      </div>
    );
  }

  renderNode(node: LaidOutNode) {
    const selected = this.selected === node.id;
    const searchActive = this.searchQuery.trim().length > 0;
    const isSearchMatch = this.searchMatchIds.has(node.id);
    const dimmed = (this.selected !== undefined && !this.path.nodes.has(node.id)) || (searchActive && !isSearchMatch);
    const focused = this.mode === "overview" && this.focus?.includes(node.namespace);
    const isUpstream = this.path.upstream.has(node.id);
    const isDownstream = this.path.downstream.has(node.id);
    const kubeObject = this.getKubeObject(node);
    const isCompact = this.density === "compact";
    const className = [
      styles.node,
      statusClass[node.status],
      isCompact ? styles.compact : "",
      selected ? styles.selected : "",
      searchActive && isSearchMatch ? styles.searchMatch : "",
      dimmed ? styles.dimmed : "",
      isUpstream ? styles.upstream : "",
      isDownstream ? styles.downstream : "",
      node.outsideView ? styles.outsideView : "",
      focused ? styles.focused : "",
    ]
      .filter(Boolean)
      .join(" ");
    const maxPods = isCompact ? 4 : node.kind === "Namespace" ? 16 : 12;

    return (
      <div
        key={node.id}
        role="button"
        tabIndex={0}
        className={className}
        style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
        onClick={() => (this.selected = selected ? undefined : node.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            this.selected = selected ? undefined : node.id;
          }
        }}
        onDoubleClick={() => node.kind === "Namespace" && this.showNamespace(node.name, "architecture")}
        onContextMenu={(evt) => {
          const controls = this.menuControls.get(node.id);

          if (controls) {
            evt.preventDefault();
            evt.stopPropagation();

            for (const [otherId, otherControls] of this.menuControls.entries()) {
              if (otherId !== node.id) {
                otherControls.close();
              }
            }

            controls.open({
              cursorPosition: { x: evt.clientX, y: evt.clientY },
              contextTarget: evt.currentTarget as HTMLElement,
            });
          }
        }}
        data-testid={`topology-node-${node.id}`}
      >
        <span className={styles.nodeHead}>
          <span className={styles.kind}>
            {node.kind}
            {node.outsideView && node.namespace ? ` · ${node.namespace}` : ""}
          </span>
          <span className={styles.headRight}>
            {isUpstream && <span className={styles.inboundTag}>↑ Inbound</span>}
            {isDownstream && <span className={styles.outboundTag}>↓ Outbound</span>}
            {!isCompact &&
              node.flags.slice(0, 2).map((flag) => (
                <span key={flag.text} className={styles.flag} title={flag.detail}>
                  {flag.text}
                </span>
              ))}
            {kubeObject && (
              <span
                role="button"
                tabIndex={0}
                className={styles.nodeMenu}
                aria-label={`Open menu for ${node.kind} ${node.name}`}
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  for (const [otherId, otherControls] of this.menuControls.entries()) {
                    if (otherId !== node.id) {
                      otherControls.close();
                    }
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    const controls = this.menuControls.get(node.id);
                    if (controls) {
                      controls.open({
                        contextTarget: e.currentTarget,
                      });
                    }
                  }
                }}
              >
                <KubeObjectMenu
                  object={kubeObject}
                  id={node.id}
                  onMenuReady={(controls) => this.menuControls.set(node.id, controls)}
                />
              </span>
            )}
          </span>
        </span>
        <span className={styles.name}>{node.name}</span>
        {!isCompact && (
          <>
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
          </>
        )}
      </div>
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
                placeholder={keys[id] ? "Key saved · type to replace" : "Viewer key (optional)"}
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
                {status.error ??
                  (status.routes !== undefined
                    ? `${status.routes} routes read · ${status.source === "entered" ? "entered key" : "viewer key from the ConfigMap"}`
                    : "No viewer key in a ConfigMap: enter one to see the routes")}
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
            <span className={styles.groupHead}>
              <span className={styles.groupLabel}>{group.label}</span>
              <span className={styles.groupMeta}>{group.meta}</span>
            </span>
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
            {/* APISIX: viewer key read automatically from ConfigMap — no toolbar toggle needed */}
            <div className={styles.segmented} role="radiogroup" aria-label="Density">
              <button
                type="button"
                role="radio"
                aria-checked={this.density === "standard"}
                className={this.density === "standard" ? styles.active : ""}
                onClick={() => {
                  this.density = "standard";
                  requestAnimationFrame(() => this.fit("width"));
                }}
              >
                ⊞ Standard
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={this.density === "compact"}
                className={this.density === "compact" ? styles.active : ""}
                onClick={() => {
                  this.density = "compact";
                  requestAnimationFrame(() => this.fit("width"));
                }}
              >
                ⊟ Compact
              </button>
            </div>
            <button
              type="button"
              className={`${styles.toggle} ${this.searchOpen ? styles.active : ""}`}
              onClick={() => {
                this.searchOpen = !this.searchOpen;
                if (this.searchOpen) {
                  setTimeout(() => this.searchInputRef?.focus(), 50);
                } else {
                  this.searchQuery = "";
                }
              }}
              title="Search on canvas (Ctrl+F)"
            >
              🔍 {this.searchQuery ? `"${this.searchQuery}" (${this.searchMatchIds.size})` : "Search"}
            </button>
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
              <button
                type="button"
                className={styles.fit}
                disabled={graph.nodes.length === 0}
                onClick={() => this.exportImage()}
                data-testid="topology-export-image"
              >
                Export PNG
              </button>
            </div>
          </div>
          {this.apisixPanelOpen && false && this.renderApisixPanel()}
          {/* APISIX viewer key is read automatically from ConfigMap — no manual key row shown */}
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
              {this.renderSearchHud()}
              {this.renderFocusHud()}
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
