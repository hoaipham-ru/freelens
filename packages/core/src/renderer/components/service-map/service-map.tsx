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
import createResourceTabInjectable from "../dock/create-resource/create-resource-tab.injectable";
import createResourceTabStoreInjectable from "../dock/create-resource/store.injectable";
import callForLogsInjectable from "../dock/logs/call-for-logs.injectable";
import createPodLogsTabInjectable from "../dock/logs/create-pod-logs-tab.injectable";
import sendCommandInjectable, { type SendCommand } from "../dock/terminal/send-command.injectable";
import eventStoreInjectable from "../events/store.injectable";
import showDetailsInjectable from "../kube-detail-params/show-details.injectable";
import { KubeObjectMenu } from "../kube-object-menu";
import { TabLayout } from "../layout/tab-layout";
import { NamespaceSelectFilter } from "../namespaces/namespace-select-filter";
import ingressClassStoreInjectable from "../network-ingresses/ingress-class-store.injectable";
import ingressStoreInjectable from "../network-ingresses/ingress-store.injectable";
import networkPolicyStoreInjectable from "../network-policies/store.injectable";
import serviceStoreInjectable from "../network-services/store.injectable";
import nodeStoreInjectable from "../nodes/store.injectable";
import storageClassStoreInjectable from "../storage-classes/store.injectable";
import persistentVolumeClaimStoreInjectable from "../storage-volume-claims/store.injectable";
import { apisixKeysOf, readApisix } from "../topology/apisix-admin";
import topologyApisixKeysStorageInjectable from "../topology/apisix-keys-storage.injectable";
import { edgeGeometry, exportServiceMapPng, roundedSvgPath } from "../topology/export-image";
import { createReferenceFinder, layoutCards, pathOf } from "../topology/topology-model";
import cronJobStoreInjectable from "../workloads-cronjobs/store.injectable";
import daemonSetStoreInjectable from "../workloads-daemonsets/store.injectable";
import deploymentStoreInjectable from "../workloads-deployments/store.injectable";
import jobStoreInjectable from "../workloads-jobs/store.injectable";
import podStoreInjectable from "../workloads-pods/store.injectable";
import replicaSetStoreInjectable from "../workloads-replicasets/store.injectable";
import statefulSetStoreInjectable from "../workloads-statefulsets/store.injectable";
import { isWatchedCustomResource } from "./custom-resources";
import styles from "./service-map.module.scss";
import { ago, buildHealthReport, podBoxes, workloadsOf } from "./service-map-model";
import serviceMapMutesStorageInjectable from "./service-map-mutes-storage.injectable";

import type { KubeJsonApi } from "@freelensapp/kube-api";
import type { KubeObject, Pod } from "@freelensapp/kube-object";

import type { ApiManager } from "../../../common/k8s-api/api-manager";
import type { ClusterContext } from "../../cluster-frame-context/cluster-frame-context";
import type { SubscribableStore, SubscribeStores } from "../../kube-watch-api/kube-watch-api";
import type { StorageLayer } from "../../utils/storage-helper";
import type { CustomResourceDefinitionStore } from "../custom-resource-definitions/store";
import type { CreateResourceTabStore } from "../dock/create-resource/store";
import type { DockTab, DockTabCreateSpecific } from "../dock/dock/store";
import type { CallForLogs } from "../dock/logs/call-for-logs.injectable";
import type { PodLogsTabData } from "../dock/logs/create-pod-logs-tab.injectable";
import type { ShowDetails } from "../kube-detail-params/show-details.injectable";
import type { MenuControls } from "../menu";
import type { ApisixInstance, RawObject, TopologyGraph, TopologyNode } from "../topology/topology-model";
import type { PodStore } from "../workloads-pods/store";
import type {
  Health,
  HealthInput,
  HealthReport,
  Incident,
  MapLink,
  MapNode,
  PodBox,
  PodInfo,
  RawEvent,
} from "./service-map-model";

type Store = SubscribableStore & { readonly items: KubeObject[]; readonly isLoaded: boolean };
type CoreKey =
  | "ingresses"
  | "services"
  | "deployments"
  | "statefulSets"
  | "daemonSets"
  | "replicaSets"
  | "cronJobs"
  | "jobs"
  | "pods"
  | "configMaps"
  | "persistentVolumeClaims"
  | "podDisruptionBudgets"
  | "networkPolicies"
  | "events";
type ClusterKey = "nodes" | "storageClasses" | "ingressClasses";
type IstioKey = "gateways" | "virtualServices";

interface Dependencies {
  subscribeStores: SubscribeStores;
  showDetails: ShowDetails;
  clusterContext: ClusterContext;
  apiManager: ApiManager;
  customResourceDefinitionStore: CustomResourceDefinitionStore;
  apiKube: KubeJsonApi;
  apisixKeys: StorageLayer<Record<string, string>>;
  mutes: StorageLayer<Record<string, number>>;
  callForLogs: CallForLogs;
  createPodLogsTab: (data: PodLogsTabData) => string;
  podStore: PodStore;
  sendCommand: SendCommand;
  createResourceTab: (tabParams?: DockTabCreateSpecific) => DockTab;
  createResourceTabStore: CreateResourceTabStore;
  stores: Record<CoreKey, Store>;
  clusterStores: Record<ClusterKey, Store>;
}

const ISTIO_RESOURCES: Record<IstioKey, string> = { gateways: "gateways", virtualServices: "virtualservices" };
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;
const CARD: [number, number] = [210, 62];
const COMPACT_CARD: [number, number] = [130, 36];
const POD_ROW = 26;
const BOX_WIDTH = 340;
const MAX_ROWS = 10;
/** The class of a name that may have no style of its own (healthy, "ok"). */
const cls = (name: string | undefined) => (name ? (styles[name] ?? "") : "");
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const healthText: Record<Health, string> = {
  ok: "Healthy",
  warn: "Degraded",
  err: "Failing",
  missing: "Doesn't exist",
  idle: "Idle",
};

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

const roundedPath = roundedSvgPath;

/** A card for the layout: the layout only reads ids, kinds, names and groups. */
const asCard = (id: string, kind: string, name: string, namespace: string): TopologyNode => ({
  id,
  kind,
  name,
  namespace,
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

@observer
class NonInjectedServiceMap extends React.Component<Dependencies> {
  private readonly deps: Dependencies;
  private readonly findReferences = createReferenceFinder();
  private canvas: HTMLDivElement | null = null;
  private readonly disposers: (() => void)[] = [];
  private disposeWatch?: () => void;
  private drag?: { x: number; y: number; panX: number; panY: number; moved: boolean };
  private userMoved = false;

  @observable accessor incidentId: string | undefined = undefined;
  @observable accessor view: "services" | "pods" = "services";
  @observable accessor groupBy: "workload" | "node" = "workload";
  @observable accessor scope: "incident" | "namespace" = "incident";
  @observable accessor filter: "all" | "critical" = "all";
  @observable accessor density: "standard" | "compact" = "standard";
  @observable accessor searchQuery = "";
  @observable accessor searchOpen = false;
  private searchInputRef: HTMLInputElement | null = null;
  @observable accessor nodeId: string | undefined = undefined;
  @observable accessor podName: string | undefined = undefined;
  @observable accessor showMuted = false;
  @observable accessor hideCritical = false;
  @observable accessor inboxOpen = true;
  @observable accessor panelOpen = true;
  @observable accessor openHousekeeping: string | undefined = undefined;
  @observable accessor showAllIssues = false;
  @observable accessor lastLine: Record<string, string> = {};
  @observable accessor copied = false;
  @observable accessor copiedReport = false;
  @observable accessor zoom = 1;
  private menuControls = new Map<string, MenuControls>();
  @observable accessor panX = 0;
  @observable accessor panY = 0;
  @observable accessor dragging = false;
  @observable accessor updatedAt = 0;
  @observable accessor clock = Date.now();
  private readonly istioStoresBox = observable.box<Partial<Record<IstioKey, Store>>>({}, { deep: false });
  // The stores of the custom resources of operators the map knows, by API base.
  private readonly crStoresBox = observable.box<Record<string, Store>>({}, { deep: false });
  private readonly inputBox = observable.box<HealthInput | undefined>(undefined, { deep: false });
  private readonly apisixBox = observable.box<ApisixInstance[]>([], { deep: false });
  private readonly secretsBox = observable.box<Set<string> | undefined>(undefined, { deep: false });

  constructor(props: Dependencies) {
    super(props);
    this.deps = props;
  }

  get istioStores() {
    return this.istioStoresBox.get();
  }

  get crStores() {
    return this.crStoresBox.get();
  }

  get input() {
    return this.inputBox.get();
  }

  componentDidMount() {
    const { subscribeStores, clusterContext, apiManager, customResourceDefinitionStore, clusterStores } = this.deps;

    this.disposers.push(
      subscribeStores([customResourceDefinitionStore, ...Object.values(clusterStores)]),
      reaction(
        () =>
          Object.entries(ISTIO_RESOURCES)
            .map(([key, plural]) => {
              const apiBase = customResourceDefinitionStore
                .getByGroup("networking.istio.io", plural)
                ?.getResourceApiBase();

              return apiBase ? `${key}=${apiBase}=${apiManager.getApi(apiBase) ? "ready" : "waiting"}` : "";
            })
            .filter(Boolean)
            .join(","),
        (found) => {
          const stores: Partial<Record<IstioKey, Store>> = {};

          for (const entry of found ? found.split(",") : []) {
            const [key, apiBase, ready] = entry.split("=");
            const store = ready === "ready" ? apiManager.getStore(apiBase) : undefined;

            if (store) {
              stores[key as IstioKey] = store as unknown as Store;
            }
          }

          this.istioStoresBox.set(stores);
        },
        { fireImmediately: true },
      ),
      // Operators (Strimzi, Vault Secrets Operator, Flux, Argo CD) say in their custom resources
      // whether they are well: read the ones whose CRDs are installed.
      reaction(
        () =>
          customResourceDefinitionStore.items
            .filter((crd) => isWatchedCustomResource(crd.getGroup(), crd.getResourceKind()))
            .map((crd) => {
              const apiBase = crd.getResourceApiBase();

              return `${apiBase}=${apiManager.getApi(apiBase) ? "ready" : "waiting"}`;
            })
            .sort()
            .join(","),
        (found) => {
          const stores: Record<string, Store> = {};

          for (const entry of found ? found.split(",") : []) {
            const [apiBase, ready] = entry.split("=");
            const store = ready === "ready" ? apiManager.getStore(apiBase) : undefined;

            if (store) {
              stores[apiBase] = store as unknown as Store;
            }
          }

          this.crStoresBox.set(stores);
        },
        { fireImmediately: true },
      ),
      // What fails in one namespace often comes from another: every namespace is loaded.
      reaction(
        () => [
          clusterContext.allNamespaces.join(","),
          Object.keys(this.istioStores).join(","),
          Object.keys(this.crStores).join(","),
        ],
        () => {
          this.disposeWatch?.();
          this.disposeWatch = undefined;

          if (clusterContext.allNamespaces.length > 0) {
            this.disposeWatch = subscribeStores(
              [
                ...Object.values(this.deps.stores),
                ...Object.values(this.istioStores),
                ...Object.values(this.crStores),
              ] as Store[],
              { namespaces: [...clusterContext.allNamespaces] },
            );
          }
        },
        { fireImmediately: true },
      ),
      reaction(
        () => JSON.stringify(Object.keys(this.apisixKeys)),
        () => void this.loadApisix(),
        { fireImmediately: true, delay: 500 },
      ),
      reaction(
        () => this.readInput(),
        (input) => {
          this.inputBox.set(input);
          this.updatedAt = Date.now();
        },
        { fireImmediately: true, delay: 500 },
      ),
      reaction(
        () => `${this.selected?.id}:${this.view}:${this.groupBy}:${this.scope}`,
        () => {
          this.userMoved = false;
          requestAnimationFrame(() => this.fit());
        },
        { fireImmediately: true },
      ),
      reaction(
        () => `${Math.round(this.layout.width / 50)}x${Math.round(this.layout.height / 50)}`,
        () => !this.userMoved && requestAnimationFrame(() => this.fit()),
      ),
    );

    void this.loadSecretNames();

    const minute = setInterval(() => {
      void this.loadApisix();
      void this.loadSecretNames();
    }, 60_000);
    const tick = setInterval(() => runInAction(() => (this.clock = Date.now())), 5_000);

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

    this.disposers.push(
      () => clearInterval(minute),
      () => clearInterval(tick),
      () => window.removeEventListener("keydown", onKeyDown),
    );
  }

  componentWillUnmount() {
    this.setCanvas(null);
    this.disposeWatch?.();
    this.disposers.forEach((dispose) => dispose());
  }

  readInput(): HealthInput {
    const { stores, clusterStores } = this.deps;
    const read = (store: Store | undefined) => (store ? store.items.map(toRaw) : []);

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
      events: read(stores.events) as unknown as RawEvent[],
      nodes: read(clusterStores.nodes),
      storageClasses: read(clusterStores.storageClasses),
      ingressClasses: read(clusterStores.ingressClasses),
      gateways: read(this.istioStores.gateways),
      virtualServices: read(this.istioStores.virtualServices),
      customResources: Object.values(this.crStores).flatMap((store) => read(store)),
      apisix: this.apisixBox.get(),
      secretNames: this.secretsBox.get(),
      now: Date.now(),
    };
  }

  @computed get apisixKeys() {
    return apisixKeysOf(
      this.deps.stores.services.items.map(toRaw),
      this.deps.stores.configMaps.items.map(toRaw),
      this.deps.apisixKeys.get(),
    );
  }

  async loadApisix() {
    const { instances } = await readApisix(
      this.deps.apiKube,
      this.deps.stores.services.items.map(toRaw),
      this.apisixKeys,
    );

    this.apisixBox.set(instances);
  }

  /**
   * Only the names of Secrets, never their data: the API server answers with the metadata
   * alone when asked for PartialObjectMetadata.
   */
  async loadSecretNames() {
    try {
      const response = await this.deps.apiKube.getResponse("/api/v1/secrets", undefined, {
        headers: { accept: "application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1" },
      });

      if (!response.ok) {
        throw new Error(String(response.status));
      }

      const list = (await response.json()) as { items?: { metadata?: { name?: string; namespace?: string } }[] };
      const names = new Set((list.items ?? []).map((item) => `${item.metadata?.namespace}/${item.metadata?.name}`));

      this.secretsBox.set(names);
    } catch {
      this.secretsBox.set(undefined); // can't tell what is missing
    }
  }

  @computed get isLoaded() {
    return Object.values(this.deps.stores).every((store) => store.isLoaded);
  }

  @computed get report(): HealthReport | undefined {
    return this.input ? buildHealthReport(this.input, { findReferences: this.findReferences }) : undefined;
  }

  @computed get focus(): string[] | undefined {
    const { clusterContext } = this.deps;

    return clusterContext.hasSelectedAll ? undefined : [...clusterContext.contextNamespaces];
  }

  @computed get muted(): Record<string, number> {
    return this.deps.mutes.get();
  }

  @computed get inView(): Incident[] {
    const focus = this.focus;

    return (this.report?.incidents ?? []).filter(
      (incident) => !focus || incident.namespaces.length === 0 || incident.namespaces.some((ns) => focus.includes(ns)),
    );
  }

  @computed get incidents(): Incident[] {
    return this.inView.filter(
      (incident) =>
        (this.showMuted || !this.muted[incident.id]) &&
        (this.filter === "all" || incident.severity === "critical") &&
        !(this.hideCritical && incident.severity === "critical"),
    );
  }

  /** What the header counts: the incidents that are neither muted nor hidden as critical. */
  @computed get counted(): Incident[] {
    return this.inView.filter(
      (incident) => !this.muted[incident.id] && !(this.hideCritical && incident.severity === "critical"),
    );
  }

  @computed get selected(): Incident | undefined {
    return this.incidents.find((incident) => incident.id === this.incidentId) ?? this.incidents[0];
  }

  // ---------------------------------------------------------------- the map

  /** The cards drawn for the selected incident, and the links between them. */
  @computed get mapNodes(): { ids: string[]; links: MapLink[] } {
    const report = this.report;
    const incident = this.selected;

    if (!report || !incident) {
      return { ids: [], links: [] };
    }

    if (this.scope === "incident") {
      return { ids: [...incident.nodeIds, ...incident.atRiskIds], links: incident.links };
    }

    const namespaces = new Set(incident.namespaces);
    const ids = new Set([...incident.nodeIds, ...incident.atRiskIds]);

    for (const node of Object.values(report.nodes)) {
      if (namespaces.has(node.namespace) && node.health !== "missing") {
        ids.add(node.id);
      }
    }

    return { ids: [...ids], links: report.links.filter((l) => ids.has(l.from) && ids.has(l.to)) };
  }

  getKubeObject(node: MapNode): KubeObject | undefined {
    if (!node.selfLink) {
      return undefined;
    }

    return this.deps.apiManager.getStore(node.selfLink)?.getByPath(node.selfLink);
  }

  @computed get path() {
    const selected = this.nodeId;

    if (!selected) {
      return {
        nodes: new Set<string>(),
        edges: new Set<string>(),
        upstream: new Set<string>(),
        downstream: new Set<string>(),
      };
    }

    const links = this.mapNodes.links;
    const edges = links.map((l) => ({
      id: `${l.from}>${l.to}`,
      from: l.from,
      to: l.to,
      type: "routes" as const,
      label: "",
      via: "",
      inferred: false,
      count: 1,
    }));

    return pathOf(edges, selected);
  }

  @computed get podView(): {
    boxes: PodBox[];
    cards: MapNode[];
    links: { from: string; to: string; tone: "err" | "ok" }[];
  } {
    const report = this.report;
    const incident = this.selected;

    return report && incident ? podBoxes(report, incident, this.groupBy) : { boxes: [], cards: [], links: [] };
  }

  @computed get layout() {
    const report = this.report;

    if (!report) {
      return { nodes: [], groups: [], routes: {}, width: 0, height: 0 };
    }

    const rootId = this.selected?.rootId;

    if (this.view === "pods") {
      const { boxes, cards, links } = this.podView;
      const heights = new Map(
        boxes.map((b) => [
          b.id,
          58 + Math.min(b.pods.length, MAX_ROWS) * POD_ROW + (b.pods.length > MAX_ROWS ? 20 : 0),
        ]),
      );
      const graph: TopologyGraph = {
        nodes: [
          ...boxes.map((b) => asCard(b.id, "box", b.title, "")),
          ...cards.map((c) => asCard(c.id, c.kind, c.name, c.namespace)),
        ],
        edges: links.map((l) => ({
          id: `${l.from}>${l.to}`,
          from: l.from,
          to: l.to,
          type: "routes",
          label: "",
          via: "",
          inferred: false,
          count: 1,
        })),
        hiddenCount: 0,
        collapsed: [],
        objectCounts: {},
      };

      if (links.length === 0 && cards.length === 0) {
        // Nothing links the boxes: one under the other, readable at full size.
        let y = 24;
        const nodes = graph.nodes.map((n) => {
          const height = heights.get(n.id) ?? 70;
          const placed = { ...n, x: 24, y, width: BOX_WIDTH, height };

          y += height + 16;

          return placed;
        });

        return { nodes, groups: [], routes: {}, width: BOX_WIDTH + 48, height: y + 8 };
      }

      const cardSize = this.density === "compact" ? COMPACT_CARD : CARD;

      return layoutCards(graph, (n) =>
        heights.has(n.id)
          ? [BOX_WIDTH, heights.get(n.id) ?? 70]
          : n.id === rootId
            ? [cardSize[0], cardSize[1] + 14]
            : cardSize,
      );
    }

    const cardSize = this.density === "compact" ? COMPACT_CARD : CARD;
    const { ids, links } = this.mapNodes;
    const graph: TopologyGraph = {
      nodes: ids.map((id) => {
        const node = report.nodes[id];

        return asCard(id, node.kind, node.name, node.namespace);
      }),
      edges: links.map((l) => ({
        id: l.id,
        from: l.from,
        to: l.to,
        type: l.type === "calls" || l.type === "mentions" ? "calls" : "routes",
        label: "",
        via: l.via,
        inferred: l.confidence !== "HIGH",
        count: 1,
      })),
      hiddenCount: 0,
      collapsed: [],
      objectCounts: {},
    };

    return layoutCards(graph, (n) => (n.id === rootId ? [cardSize[0], cardSize[1] + 14] : cardSize));
  }

  @computed get searchMatchIds(): Set<string> {
    const q = this.searchQuery.trim().toLowerCase();
    const report = this.report;

    if (!q || !report) {
      return new Set();
    }

    const matched = new Set<string>();

    for (const node of Object.values(report.nodes)) {
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

  // ---------------------------------------------------------------- moving around

  @action
  fit() {
    const element = this.canvas;
    const { nodes } = this.layout;

    if (!element || nodes.length === 0) {
      return;
    }

    // The layout keeps a minimum size; fit what is drawn.
    const width = Math.max(...nodes.map((n) => n.x + n.width)) + 24;
    const height = Math.max(...nodes.map((n) => n.y + n.height)) + 24;

    // Fit, but not so small that the cards can't be read: past that, the rest is a drag away.
    const scale = Math.min(element.clientWidth / width, (element.clientHeight - 40) / height);

    this.zoom = clamp(Math.floor(scale * 20) / 20, 0.5, 1);
    this.panX = Math.max(0, (element.clientWidth - width * this.zoom) / 2);
    this.panY = Math.max(40, (element.clientHeight - height * this.zoom) / 2);
  }

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
      this.nodeId = undefined;
      this.podName = undefined;
    }

    this.drag = undefined;
    this.dragging = false;
  });

  // ---------------------------------------------------------------- actions

  @action
  pickIncident(id: string) {
    this.incidentId = id;
    this.nodeId = undefined;
    this.podName = undefined;
    this.showAllIssues = false;
  }

  @action
  toggleMute(incident: Incident) {
    const { [incident.id]: wasMuted, ...rest } = this.muted;

    this.deps.mutes.set(wasMuted ? rest : { ...rest, [incident.id]: Date.now() });
  }

  openLogs(namespace: string, podName: string, container?: string) {
    const pod = this.deps.podStore.getByName(podName, namespace) as Pod | undefined;

    if (!pod) {
      return;
    }

    const selectedContainer =
      pod.getAllContainers().find((c) => c.name === container) ?? pod.getContainers()[0] ?? pod.getAllContainers()[0];

    if (selectedContainer) {
      this.deps.createPodLogsTab({ selectedPod: pod, selectedContainer });
    }
  }

  openPrimary(incident: Incident) {
    const { primary } = incident;
    const node = this.report?.nodes[primary.nodeId];

    if (primary.pod && node) {
      this.openLogs(node.namespace, primary.pod, primary.container);
    } else if (node?.selfLink) {
      this.deps.showDetails(node.selfLink);
    }
  }

  async copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      runInAction(() => (this.copied = true));
      setTimeout(() => runInAction(() => (this.copied = false)), 1500);
    } catch {
      // the clipboard can be refused; the command is on screen to select by hand
    }
  }

  async copyReport(incident: Incident) {
    const report = this.report as HealthReport;
    const root = report?.nodes[incident.rootId];
    const rootText = root ? `${root.kind} ${root.namespace ? `${root.namespace}/` : ""}${root.name}` : incident.rootId;
    const markdown = [
      `### 🚨 [${incident.severity.toUpperCase()}] ${incident.title}`,
      `- **Since:** ${incident.sinceText}`,
      `- **Root Cause:** ${rootText}`,
      `- **What's wrong:** ${incident.cause}`,
      incident.risk ? `- **Risk:** ${incident.risk}` : undefined,
      `- **Suggested Action:** ${incident.action}`,
      incident.cmd ? `- **Diagnostic Command:** \`${incident.cmd}\`` : undefined,
    ]
      .filter(Boolean)
      .join("\n");

    try {
      await navigator.clipboard.writeText(markdown);
      runInAction(() => (this.copiedReport = true));
      setTimeout(() => runInAction(() => (this.copiedReport = false)), 1500);
    } catch {
      // the clipboard can be refused
    }
  }

  openAutoFix(node: MapNode) {
    const kind = node.kind;
    const name = node.name;
    const namespace = node.namespace || "default";

    let yaml = "";

    if (kind === "ConfigMap") {
      yaml = [
        "apiVersion: v1",
        "kind: ConfigMap",
        "metadata:",
        `  name: ${name}`,
        `  namespace: ${namespace}`,
        "data:",
        "  # Add required configuration keys here",
        '  EXAMPLE_KEY: "example_value"',
      ].join("\n");
    } else if (kind === "Secret") {
      yaml = [
        "apiVersion: v1",
        "kind: Secret",
        "metadata:",
        `  name: ${name}`,
        `  namespace: ${namespace}`,
        "type: Opaque",
        "stringData:",
        "  # Add required secret keys here",
        '  KEY: "value"',
      ].join("\n");
    } else if (kind === "PersistentVolumeClaim") {
      yaml = [
        "apiVersion: v1",
        "kind: PersistentVolumeClaim",
        "metadata:",
        `  name: ${name}`,
        `  namespace: ${namespace}`,
        "spec:",
        "  accessModes:",
        "    - ReadWriteOnce",
        "  resources:",
        "    requests:",
        "      storage: 10Gi",
      ].join("\n");
    } else {
      yaml = ["apiVersion: v1", `kind: ${kind}`, "metadata:", `  name: ${name}`, `  namespace: ${namespace}`].join(
        "\n",
      );
    }

    const tab = this.deps.createResourceTab({ title: `Create ${kind}: ${name}` });

    if (tab?.id) {
      this.deps.createResourceTabStore.setData(tab.id, yaml);
    }
  }

  renderSearchHud() {
    if (!this.searchOpen) {
      return null;
    }

    return (
      <div className={styles.searchHud} data-testid="service-map-search-hud">
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

  async loadLastLine(pod: PodInfo) {
    const key = `${pod.namespace}/${pod.name}`;
    const container = pod.containers.find((c) => c.health === "err") ?? pod.containers.find((c) => c.kind === "main");

    if (!container || this.lastLine[key] !== undefined) {
      return;
    }

    try {
      const previous = container.restarts > 0 && container.health === "err";
      const text = await this.deps.callForLogs(
        { name: pod.name, namespace: pod.namespace },
        { container: container.name, tailLines: 1, previous, timestamps: false },
      );

      runInAction(() => (this.lastLine = { ...this.lastLine, [key]: text.trim() || "(no output)" }));
    } catch (error) {
      runInAction(
        () =>
          (this.lastLine = {
            ...this.lastLine,
            [key]: `Can't read the logs: ${error instanceof Error ? error.message : error}`,
          }),
      );
    }
  }

  @action
  pickPod(pod: PodInfo) {
    this.podName = this.podName === pod.name ? undefined : pod.name;
    this.nodeId = undefined;

    if (this.podName) {
      void this.loadLastLine(pod);
    }
  }

  // ---------------------------------------------------------------- drawing

  roleOf(id: string): "root" | "failing" | "missing" | "atRisk" | "healthy" {
    const incident = this.selected;
    const node = this.report?.nodes[id];

    if (!incident || !node) return "healthy";
    if (incident.rootId === id) return "root";
    if (node.health === "missing") return "missing";
    if (incident.nodeIds.includes(id)) return "failing";
    if (incident.atRiskIds.includes(id)) return "atRisk";

    return "healthy";
  }

  get edgeLines(): { id: string; tone: "fail" | "risk" | "decl"; title: string; inferred?: boolean }[] {
    const isWarning = this.selected?.severity === "warning";

    return this.view === "pods"
      ? this.podView.links.map((l) => ({
          id: `${l.from}>${l.to}`,
          tone: l.tone === "err" ? (isWarning ? ("risk" as const) : ("fail" as const)) : ("decl" as const),
          title: "",
        }))
      : this.mapNodes.links.map((l) => {
          const toRole = this.roleOf(l.to);
          const fromRole = this.roleOf(l.from);
          const tone: "fail" | "risk" | "decl" =
            (toRole === "root" || toRole === "failing" || toRole === "missing") &&
            (fromRole === "failing" || fromRole === "root")
              ? isWarning
                ? "risk"
                : "fail"
              : fromRole === "atRisk"
                ? "risk"
                : "decl";

          return { id: l.id, tone, title: `${l.type}: ${l.via}`, inferred: l.confidence !== "HIGH" };
        });
  }

  exportImage() {
    const report = this.report;
    const incident = this.selected;

    if (!report || !incident) {
      return;
    }

    exportServiceMapPng({
      element: this.canvas,
      layout: this.layout,
      boxes: new Map(this.podView.boxes.map((b) => [b.id, b])),
      nodes: report.nodes,
      roleOf: (id) => this.roleOf(id),
      lines: this.edgeLines,
      groupBy: this.groupBy,
      severity: incident.severity,
      filename: `service-map-${this.view}-${incident.id.replace(/[^a-z0-9-_]+/gi, "-")}.png`,
    });
  }

  renderEdges() {
    const { routes } = this.layout;
    const report = this.report;

    if (!report) return null;

    const highlight = this.nodeId !== undefined;

    return this.edgeLines
      .filter((line) => (routes[line.id]?.length ?? 0) >= 2)
      .map((item) => {
        const { line, arrow } = edgeGeometry(routes[item.id]);
        const onPath = this.path.edges.has(item.id);
        const className = [
          styles.edge,
          cls(item.tone),
          item.inferred ? styles.inferred : "",
          onPath ? styles.onPath : highlight ? styles.dimmed : "",
        ]
          .filter(Boolean)
          .join(" ");

        return (
          <g key={item.id} className={className}>
            <path d={roundedPath(line)} />
            <path d={arrow} className={styles.arrow} />
            {item.title && <title>{item.title}</title>}
          </g>
        );
      });
  }

  renderCard(node: MapNode, x: number, y: number, width: number, height: number) {
    const role = this.roleOf(node.id);
    const selected = this.nodeId === node.id;
    const highlight = this.nodeId !== undefined;
    const searchActive = this.searchQuery.trim().length > 0;
    const isSearchMatch = this.searchMatchIds.has(node.id);
    const onPath = this.path.nodes.has(node.id);
    const isUpstream = this.path.upstream.has(node.id);
    const isDownstream = this.path.downstream.has(node.id);
    const kubeObject = this.getKubeObject(node);
    const isCompact = this.density === "compact";

    const cardClasses = [
      styles.card,
      cls(node.health),
      cls(role),
      isCompact ? styles.compact : "",
      selected ? styles.selected : "",
      searchActive && isSearchMatch ? styles.searchMatch : "",
      (highlight && !onPath) || (searchActive && !isSearchMatch) ? styles.dimmed : "",
      isUpstream ? styles.upstream : "",
      isDownstream ? styles.downstream : "",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <div
        key={node.id}
        role="button"
        tabIndex={0}
        className={cardClasses}
        style={{ left: x, top: y, width, height }}
        onClick={() => {
          this.nodeId = selected ? undefined : node.id;
          this.podName = undefined;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            this.nodeId = selected ? undefined : node.id;
            this.podName = undefined;
          }
        }}
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
        data-testid={`service-map-node-${node.id}`}
      >
        <span className={styles.cardHead}>
          <span className={styles.kind}>
            {node.kind}
            {node.namespace ? ` · ${node.namespace}` : ""}
          </span>
          <span className={styles.headRight}>
            {isUpstream && <span className={styles.inboundTag}>↑ Inbound</span>}
            {isDownstream && <span className={styles.outboundTag}>↓ Outbound</span>}
            {!isCompact && node.badge && <span className={styles.badge}>{node.badge}</span>}
            {kubeObject && (
              <span
                role="button"
                tabIndex={0}
                className={styles.cardMenu}
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
          <span className={styles.sub}>
            {node.health === "missing" ? "does not exist" : node.sub || healthText[node.health]}
          </span>
        )}
        {role === "root" && !isCompact && <span className={styles.rootTag}>Suspected root cause</span>}
      </div>
    );
  }

  renderBox(box: PodBox, x: number, y: number, width: number, height: number) {
    return (
      <div
        key={box.id}
        className={[
          styles.box,
          cls(box.health),
          box.root ? styles.root : "",
          box.atRisk ? styles.atRisk : "",
          box.behind ? styles.behind : "",
        ].join(" ")}
        style={{ left: x, top: y, width, height }}
      >
        <div className={styles.boxHead}>
          <span className={styles.boxTitle}>
            <span className={styles.name} title={box.title}>
              {box.title}
            </span>
            {box.badge && <span className={styles.badge}>{box.badge}</span>}
          </span>
          <span className={styles.kind} title={box.behind ? `Its pods serve ${box.behind}` : undefined}>
            {box.behind ? `${box.sub} · behind ${box.behind}` : box.sub}
          </span>
        </div>
        {box.pods.slice(0, MAX_ROWS).map((pod) => (
          <button
            key={`${pod.namespace}/${pod.name}`}
            type="button"
            className={`${styles.podRow} ${this.podName === pod.name ? styles.selected : ""}`}
            onClick={() => this.pickPod(pod)}
            title={pod.name}
          >
            <span className={`${styles.dot} ${cls(pod.health)}`} />
            <span className={styles.podName}>{pod.name}</span>
            <span className={`${styles.podStatus} ${cls(pod.health)}`}>{pod.status}</span>
            <span className={styles.podNode}>
              {this.groupBy === "workload" ? pod.node : pod.ownerId.split("/").at(-1)}
            </span>
          </button>
        ))}
        {box.pods.length > MAX_ROWS && <span className={styles.more}>+{box.pods.length - MAX_ROWS} pods</span>}
      </div>
    );
  }

  renderCanvas() {
    const { layout, report } = this;
    const incident = this.selected;

    if (!report) {
      return <p className={styles.empty}>Loading the cluster…</p>;
    }

    if (!incident) {
      return (
        <p className={styles.empty}>
          {this.isLoaded ? "No incidents in the selected namespaces." : "Reading the cluster…"}
        </p>
      );
    }

    const boxes = new Map(this.podView.boxes.map((b) => [b.id, b]));

    if (this.view === "pods" && boxes.size === 0 && this.podView.cards.length === 0) {
      const kinds = [...new Set(incident.nodeIds.map((id) => report.nodes[id]?.kind).filter(Boolean))];

      return (
        <p className={styles.empty}>
          No pods to show: this incident is about {kinds.join(", ")}, and no workload with pods is behind them.
        </p>
      );
    }

    return (
      <div
        className={styles.scaled}
        style={{
          width: layout.width,
          height: layout.height,
          transform: `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`,
        }}
      >
        <svg className={styles.edges} width={layout.width} height={layout.height} aria-hidden="true">
          {this.renderEdges()}
        </svg>
        {layout.nodes.map((n) => {
          if (this.view === "pods") {
            const box = boxes.get(n.id);

            if (box) {
              return this.renderBox(box, n.x, n.y, n.width, n.height);
            }
          }

          const node = report.nodes[n.id];

          return node ? this.renderCard(node, n.x, n.y, n.width, n.height) : null;
        })}
      </div>
    );
  }

  renderTimeline(incident: Incident) {
    const { rows, start, end } = incident.timeline;
    const hours = 6;

    return (
      <div className={styles.timeline}>
        <div className={styles.timelineHead}>
          <span className={styles.sectionTitle}>What changed</span>
          <span className={styles.muted}>
            last {hours} hours · from Warning events, which Kubernetes keeps for about an hour
          </span>
        </div>
        {rows.length === 0 ? (
          <p className={styles.muted}>No Warning events for these objects.</p>
        ) : (
          rows.map((row) => (
            <div key={row.label} className={styles.timelineRow}>
              <span className={styles.timelineLabel} title={row.label}>
                {row.label}
              </span>
              <span className={styles.track}>
                {row.bands.map(([a, b]) => (
                  <span
                    key={`${a}-${b}`}
                    className={`${styles.band} ${cls(row.tone)}`}
                    style={{ left: `${a * 100}%`, width: `${Math.max(0.4, (b - a) * 100)}%` }}
                  />
                ))}
                {row.ticks.map((t) => (
                  <span key={t} className={`${styles.tick} ${cls(row.tone)}`} style={{ left: `${t * 100}%` }} />
                ))}
              </span>
            </div>
          ))
        )}
        <div className={styles.hours}>
          <span className={styles.timelineLabel} />
          <span className={styles.hourScale}>
            {Array.from({ length: hours / 2 + 1 }, (_, step) => {
              const i = step * 2;
              const at = start + ((end - start) * i) / hours;

              return (
                <span key={i} style={{ left: `${(i / hours) * 100}%` }} title={new Date(at).toLocaleString()}>
                  {i === hours ? "now" : `−${hours - i}h`}
                </span>
              );
            })}
          </span>
        </div>
      </div>
    );
  }

  renderInbox() {
    const report = this.report;
    const critical = this.inView.filter((i) => i.severity === "critical" && !this.muted[i.id]).length;
    const mutedCount = this.inView.filter((i) => this.muted[i.id]).length;
    const shownCount = this.inView.filter(
      (i) => (this.showMuted || !this.muted[i.id]) && !(this.hideCritical && i.severity === "critical"),
    ).length;

    return (
      <aside className={styles.inbox}>
        <div className={styles.inboxHead}>
          <span className={styles.sectionTitle}>Incidents</span>
          <div className={styles.segmented} role="radiogroup" aria-label="Show">
            <button
              type="button"
              role="radio"
              aria-checked={this.filter === "all"}
              className={this.filter === "all" ? styles.active : ""}
              onClick={() => (this.filter = "all")}
            >
              All {shownCount}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={this.filter === "critical"}
              className={this.filter === "critical" ? styles.active : ""}
              onClick={() => {
                this.filter = "critical";
                this.hideCritical = false;
              }}
            >
              Critical {critical}
            </button>
          </div>
        </div>
        <ul className={styles.incidentList}>
          {this.incidents.map((incident) => (
            <li key={incident.id}>
              <button
                type="button"
                className={`${styles.incidentItem} ${this.selected?.id === incident.id ? styles.selected : ""} ${cls(incident.severity)}`}
                onClick={() => this.pickIncident(incident.id)}
                data-testid={`service-map-incident-${incident.id}`}
              >
                <span className={`${styles.dot} ${incident.severity === "critical" ? styles.err : styles.warn}`} />
                <span className={styles.incidentText}>
                  <span className={styles.incidentTitle}>
                    {incident.title}
                    {this.muted[incident.id] ? " · muted" : ""}
                  </span>
                  <span className={styles.incidentMeta}>{incident.meta}</span>
                  {incident.tags.length > 0 && (
                    <span className={styles.tags}>
                      {incident.tags.map((tag) => (
                        <span key={tag} className={styles.tag}>
                          {tag}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
          {this.incidents.length === 0 && <li className={styles.muted}>Nothing urgent here.</li>}
        </ul>
        {mutedCount > 0 && (
          <button type="button" className={styles.linkButton} onClick={() => (this.showMuted = !this.showMuted)}>
            {this.showMuted ? "Hide" : "Show"} {mutedCount} muted
          </button>
        )}
        {(critical > 0 || this.hideCritical) && (
          <button
            type="button"
            className={styles.linkButton}
            aria-pressed={this.hideCritical}
            data-testid="service-map-hide-critical"
            onClick={() => {
              this.hideCritical = !this.hideCritical;

              if (this.hideCritical) {
                this.filter = "all";
              }
            }}
          >
            {this.hideCritical ? "Show" : "Hide"} {critical} critical
          </button>
        )}
        {report && report.housekeeping.length > 0 && (
          <div className={styles.housekeeping}>
            <div className={styles.inboxHead}>
              <span className={styles.sectionTitle}>Housekeeping</span>
              <span className={styles.muted}>
                {report.housekeeping.reduce((sum, h) => sum + h.count, 0)} issues, not urgent
              </span>
            </div>
            <ul>
              {report.housekeeping.map((group) => (
                <li key={group.rule}>
                  <button
                    type="button"
                    className={styles.houseItem}
                    aria-expanded={this.openHousekeeping === group.rule}
                    onClick={() =>
                      (this.openHousekeeping = this.openHousekeeping === group.rule ? undefined : group.rule)
                    }
                  >
                    <span className={styles.incidentText}>
                      <span className={styles.houseTitle}>{group.title}</span>
                      <span className={styles.incidentMeta}>{group.note}</span>
                    </span>
                    <span className={styles.count}>{group.count}</span>
                  </button>
                  {this.openHousekeeping === group.rule && (
                    <ul className={styles.houseIssues}>
                      {group.issues.slice(0, 50).map((i) => {
                        const node = report.nodes[i.nodeId];

                        return (
                          <li key={i.id}>
                            <button
                              type="button"
                              className={styles.linkRow}
                              onClick={() => node?.selfLink && this.deps.showDetails(node.selfLink)}
                              title={i.detail}
                            >
                              <span className={styles.rowName}>
                                {node?.namespace ? `${node.namespace}/` : ""}
                                {node?.name ?? i.nodeId}
                              </span>
                              <span className={styles.rowVia}>{i.detail}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>
    );
  }

  /** What the incident is about: the objects that fail with it, and what is at risk. */
  renderAffected(incident: Incident) {
    const report = this.report as HealthReport;
    const failing = incident.nodeIds.filter((id) => id !== incident.rootId);
    const row = (id: string) => {
      const node = report.nodes[id];

      return (
        <li key={id}>
          <button type="button" className={styles.linkRow} onClick={() => (this.nodeId = id)}>
            <span className={`${styles.dot} ${cls(node.health)}`} />
            <span className={styles.rowName}>
              {node.namespace ? `${node.namespace}/` : ""}
              {node.name}
            </span>
            <span className={styles.rowVia}>
              {node.kind}
              {node.pods.length > 0 ? ` · ${node.pods.length} pods` : ""}
            </span>
          </button>
        </li>
      );
    };
    const pods = workloadsOf(report, incident).reduce((sum, w) => sum + report.nodes[w.id].pods.length, 0);

    if (failing.length === 0 && incident.atRiskIds.length === 0) {
      return null;
    }

    return (
      <section>
        <h3>
          {[
            "Affected",
            failing.length ? `${failing.length} with it` : "",
            incident.atRiskIds.length ? `${incident.atRiskIds.length} at risk` : "",
            pods ? `${pods} pods` : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </h3>
        <ul>
          {failing.slice(0, 8).map(row)}
          {incident.atRiskIds.slice(0, failing.length >= 8 ? 0 : 8 - failing.length).map(row)}
        </ul>
        {failing.length + incident.atRiskIds.length > 8 && (
          <span className={styles.muted}>+{failing.length + incident.atRiskIds.length - 8} more on the map</span>
        )}
        {pods > 0 && (
          <button type="button" className={styles.linkButton} onClick={() => (this.view = "pods")}>
            Show the {pods} pods
          </button>
        )}
      </section>
    );
  }

  renderIncidentPanel(incident: Incident) {
    const report = this.report as HealthReport;
    const root = report.nodes[incident.rootId];
    const issues = this.showAllIssues ? incident.issues : [];

    return (
      <>
        <header className={styles.panelHead}>
          <span className={`${styles.sev} ${cls(incident.severity)}`}>{incident.severity}</span>
          <span className={styles.muted}>{incident.sinceText}</span>
        </header>
        <h2 className={styles.panelTitle}>{incident.title}</h2>
        <div className={`${styles.rootBox} ${incident.isolated ? styles.isolated : ""}`}>
          <span className={styles.rootLabel}>{incident.isolated ? "Isolated failure" : "Suspected root cause"}</span>
          <button type="button" className={styles.rootName} onClick={() => (this.nodeId = root.id)}>
            <span className={styles.kind}>{root.kind}</span> {root.namespace ? `${root.namespace}/` : ""}
            {root.name}
          </button>
        </div>
        <section>
          <h3>What's wrong</h3>
          <p>{incident.cause}</p>
          {incident.risk && <p className={styles.risk}>{incident.risk}</p>}
        </section>
        {this.renderAffected(incident)}
        <section>
          <h3>Why these belong together</h3>
          <ul className={styles.facts}>
            {incident.facts.map((fact) => (
              <li key={fact.text}>
                {fact.confidence ? (
                  <span className={`${styles.conf} ${cls(fact.confidence.toLowerCase())}`}>{fact.confidence}</span>
                ) : (
                  <span className={styles.conf} />
                )}
                <span>{fact.text}</span>
                {fact.count > 0 && <span className={styles.count}>{fact.count}</span>}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => (this.showAllIssues = !this.showAllIssues)}
          >
            {incident.issues.length === 1 ? "1 issue" : `${incident.issues.length} issues merged`} ·{" "}
            {this.showAllIssues ? "hide" : "show all"}
          </button>
          {issues.length > 0 && (
            <ul className={styles.issueList}>
              {issues.map((i) => (
                <li key={i.id}>
                  <button type="button" className={styles.linkRow} onClick={() => (this.nodeId = i.nodeId)}>
                    <span className={`${styles.dot} ${i.severity === "critical" ? styles.err : styles.warn}`} />
                    <span className={styles.rowName}>{report.nodes[i.nodeId]?.name}</span>
                    <span className={styles.rowVia}>{i.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h3>Next step</h3>
          <p>{incident.action}</p>
          {incident.cmd && (
            <div className={styles.cmd}>
              <code>{incident.cmd}</code>
              <div className={styles.cmdActions}>
                <button type="button" onClick={() => void this.copy(incident.cmd)}>
                  {this.copied ? "Copied" : "Copy"}
                </button>
                <button
                  type="button"
                  className={styles.runBtn}
                  onClick={() => void this.deps.sendCommand(incident.cmd, { enter: true })}
                  title="Run command in Freelens Terminal"
                >
                  ⚡ Run
                </button>
              </div>
            </div>
          )}
        </section>
        {root &&
          (root.health === "missing" ||
            incident.cause.toLowerCase().includes("does not exist") ||
            incident.cause.toLowerCase().includes("missing")) && (
            <div className={styles.autoFixBox}>
              <div className={styles.autoFixHead}>
                <span className={styles.autoFixBadge}>⚡ 1-Click Auto-Fix</span>
                <span className={styles.autoFixHint}>Pre-filled template</span>
              </div>
              <p className={styles.autoFixDesc}>
                Create the missing <strong>{root.kind}</strong>{" "}
                <code>
                  {root.namespace ? `${root.namespace}/` : ""}
                  {root.name}
                </code>{" "}
                to unblock dependent workloads.
              </p>
              <div className={styles.autoFixActions}>
                <button
                  type="button"
                  className={styles.autoFixBtn}
                  onClick={() => this.openAutoFix(root)}
                  title="Open Create Resource dock with pre-filled manifest template"
                >
                  ✨ Quick Create {root.kind}...
                </button>
              </div>
            </div>
          )}
        <div className={styles.actions}>
          <button type="button" className={styles.primary} onClick={() => this.openPrimary(incident)}>
            {incident.primary.pod ? "Open logs" : incident.primary.label}
          </button>
          {root.selfLink && (
            <button type="button" onClick={() => this.deps.showDetails(root.selfLink)}>
              Events
            </button>
          )}
          <button type="button" onClick={() => void this.copyReport(incident)}>
            {this.copiedReport ? "Report Copied" : "Copy Report"}
          </button>
          <button type="button" onClick={() => this.toggleMute(incident)}>
            {this.muted[incident.id] ? "Unmute" : "Mute"}
          </button>
        </div>
      </>
    );
  }

  renderNodePanel(node: MapNode) {
    const report = this.report as HealthReport;
    const outgoing = report.links.filter((l) => l.from === node.id);
    const incoming = report.links.filter((l) => l.to === node.id);
    const row = (l: MapLink, otherId: string) => {
      const other = report.nodes[otherId];

      return (
        <li key={l.id}>
          <button type="button" className={styles.linkRow} onClick={() => (this.nodeId = otherId)}>
            <span className={`${styles.dot} ${cls(other?.health ?? "ok")}`} />
            <span className={styles.rowName}>
              {other?.namespace && other.namespace !== node.namespace ? `${other.namespace}/` : ""}
              {other?.name ?? otherId}
            </span>
            <span className={styles.rowVia} title={l.via}>
              {l.type} · {l.via}
            </span>
          </button>
        </li>
      );
    };

    return (
      <>
        <button type="button" className={styles.linkButton} onClick={() => (this.nodeId = undefined)}>
          ← Back to incident
        </button>
        <header className={styles.panelHead}>
          <span className={`${styles.dot} ${cls(node.health)}`} />
          <span className={styles.kind}>{node.kind}</span>
        </header>
        <h2 className={styles.panelTitle}>{node.name}</h2>
        <p className={styles.muted}>
          {[node.namespace, node.health === "missing" ? "does not exist" : node.sub, healthText[node.health]]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {node.issues.length > 0 && (
          <section>
            <h3>Issues</h3>
            <ul className={styles.issueList}>
              {node.issues.map((i) => (
                <li key={i.id} className={styles.issue}>
                  <span className={styles.issueTitle}>
                    <span
                      className={`${styles.dot} ${i.severity === "critical" ? styles.err : i.severity === "warning" ? styles.warn : styles.idle}`}
                    />
                    {i.title}
                    {i.since ? <span className={styles.muted}> · {ago(this.clock - i.since)}</span> : null}
                  </span>
                  <span>{i.detail}</span>
                  {i.message && <code className={styles.message}>{i.message}</code>}
                </li>
              ))}
            </ul>
          </section>
        )}
        <section>
          <h3>Depends on</h3>
          {outgoing.length ? (
            <ul>{outgoing.map((l) => row(l, l.to))}</ul>
          ) : (
            <p className={styles.muted}>No outgoing links found.</p>
          )}
        </section>
        <section>
          <h3>Used by</h3>
          {incoming.length ? (
            <ul>{incoming.slice(0, 12).map((l) => row(l, l.from))}</ul>
          ) : (
            <p className={styles.muted}>Nothing in the cluster points here.</p>
          )}
        </section>
        {node.pods.length > 0 && (
          <section>
            <h3>Pods</h3>
            <ul>
              {node.pods.map((pod) => (
                <li key={pod.name}>
                  <button
                    type="button"
                    className={styles.linkRow}
                    onClick={() => {
                      this.view = "pods";
                      this.pickPod(pod);
                    }}
                  >
                    <span className={`${styles.dot} ${cls(pod.health)}`} />
                    <span className={styles.rowName}>{pod.name}</span>
                    <span className={styles.rowVia}>{pod.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <div className={styles.actions}>
          {node.pods[0] && (
            <button
              type="button"
              className={styles.primary}
              onClick={() => {
                const pod = node.pods.find((p) => p.health === "err") ?? node.pods[0];

                this.openLogs(pod.namespace, pod.name);
              }}
            >
              Open logs
            </button>
          )}
          {node.selfLink && (
            <button type="button" onClick={() => this.deps.showDetails(node.selfLink)}>
              Details
            </button>
          )}
        </div>
      </>
    );
  }

  renderPodPanel(pod: PodInfo) {
    const report = this.report as HealthReport;
    const owner = report.nodes[pod.ownerId];
    const talksTo = report.links.filter((l) => l.from === pod.ownerId && (l.type === "calls" || l.type === "mentions"));
    const line = this.lastLine[`${pod.namespace}/${pod.name}`];
    const failing = pod.containers.find((c) => c.health === "err");

    return (
      <>
        <button type="button" className={styles.linkButton} onClick={() => (this.podName = undefined)}>
          ← Back to incident
        </button>
        <header className={styles.panelHead}>
          <span className={`${styles.dot} ${cls(pod.health)}`} />
          <span className={styles.kind}>Pod</span>
        </header>
        <h2 className={styles.panelTitle}>{pod.name}</h2>
        <p className={styles.muted}>
          {owner?.name} · on {pod.node || "no node"} · {pod.status}
        </p>
        <section>
          <h3>Containers</h3>
          <ul>
            {pod.containers.map((c) => (
              <li key={`${c.kind}/${c.name}`} className={styles.containerRow}>
                <span className={`${styles.dot} ${cls(c.health)}`} />
                <span className={styles.rowName}>{c.name}</span>
                <span className={styles.rowVia}>
                  {c.kind === "init" ? "init · " : ""}
                  {c.state}
                  {c.restarts ? ` · ${c.restarts} restarts` : ""}
                  {c.lastExit ? ` · last ${c.lastExit}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3>Last log line{failing?.restarts ? " · previous run" : ""}</h3>
          <code className={styles.message}>{line ?? "Reading…"}</code>
        </section>
        {talksTo.length > 0 && (
          <section>
            <h3>Talks to</h3>
            <ul>
              {talksTo.map((l) => (
                <li key={l.id}>
                  <span className={styles.rowName}>{report.nodes[l.to]?.name}</span>
                  <span className={styles.rowVia}>{l.via}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primary}
            onClick={() => this.openLogs(pod.namespace, pod.name, failing?.name)}
          >
            Open logs
          </button>
          <button type="button" onClick={() => this.deps.showDetails(pod.selfLink)}>
            Events
          </button>
        </div>
      </>
    );
  }

  renderPanel() {
    const report = this.report;
    const incident = this.selected;

    if (!report || !incident) {
      return null;
    }

    const pod = this.podName
      ? Object.values(report.nodes)
          .flatMap((n) => n.pods)
          .find((p) => p.name === this.podName)
      : undefined;
    const node = this.nodeId ? report.nodes[this.nodeId] : undefined;

    return (
      <aside className={styles.panel} data-testid="service-map-panel">
        {pod ? this.renderPodPanel(pod) : node ? this.renderNodePanel(node) : this.renderIncidentPanel(incident)}
      </aside>
    );
  }

  renderFocusHud() {
    if (!this.nodeId || !this.report) {
      return null;
    }

    const node = this.report.nodes[this.nodeId];

    if (!node) {
      return null;
    }

    return (
      <div className={styles.focusHud} data-testid="service-map-focus-hud">
        <span className={styles.focusBadge}>FOCUS MODE</span>
        <span className={styles.focusTarget}>
          <strong>{node.kind}</strong> {node.namespace ? `${node.namespace}/` : ""}
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
            this.nodeId = undefined;
          }}
          title="Exit Focus Mode"
        >
          ✕ Exit Focus
        </button>
      </div>
    );
  }

  renderLegend() {
    if (this.view === "pods") {
      return (
        <div className={styles.legend}>
          <span>
            <i className={`${styles.dot}`} /> running
          </span>
          <span>
            <i className={`${styles.dot} ${styles.warn}`} /> at risk
          </span>
          <span>
            <i className={`${styles.dot} ${styles.err}`} /> failing
          </span>
        </div>
      );
    }

    return (
      <div className={styles.legend}>
        <span>
          <i className={`${styles.swatch} ${styles.root}`} /> root cause
        </span>
        <span>
          <i className={`${styles.swatch} ${styles.failing}`} /> failing
        </span>
        <span>
          <i className={`${styles.swatch} ${styles.atRisk}`} /> at risk
        </span>
        <span>
          <i className={`${styles.swatch} ${styles.missing}`} /> missing
        </span>
        <span>
          <i className={styles.lineDashed} /> inferred
        </span>
      </div>
    );
  }

  render() {
    const report = this.report;
    const incident = this.selected;
    const seconds = Math.max(0, Math.round((this.clock - this.updatedAt) / 1000));

    return (
      <TabLayout>
        <div className={styles.serviceMap} data-testid="service-map-page">
          <div className={styles.header}>
            <h5>Service map</h5>
            {report && (
              <span className={styles.chips}>
                <span className={styles.chip}>{report.issueCount} issues</span>
                <span
                  className={`${styles.chip} ${this.counted.some((i) => i.severity === "critical") ? styles.err : ""}`}
                >
                  {this.counted.length} incidents
                </span>
              </span>
            )}
            <span className={styles.grow} />
            <span className={styles.muted}>
              {this.updatedAt ? `Updated ${seconds < 10 ? "just now" : `${seconds}s ago`}` : ""}
              {this.secretsBox.get() === undefined && report
                ? " · Secrets can't be listed: missing ones aren't checked"
                : ""}
            </span>
            <NamespaceSelectFilter id="service-map-namespace-select-filter-input" />
          </div>
          <div className={`${styles.body} ${this.selected?.severity === "warning" ? styles.warnIncident : ""}`}>
            {this.inboxOpen && this.renderInbox()}
            <div className={styles.main}>
              <div className={styles.toolbar}>
                <button
                  type="button"
                  className={styles.toggle}
                  aria-pressed={this.inboxOpen}
                  title={this.inboxOpen ? "Hide the list of incidents" : "Show the list of incidents"}
                  onClick={() => {
                    this.inboxOpen = !this.inboxOpen;
                    requestAnimationFrame(() => this.fit());
                  }}
                >
                  {this.inboxOpen ? "‹ Incidents" : `› Incidents · ${this.incidents.length}`}
                </button>
                <div className={styles.segmented} role="radiogroup" aria-label="View">
                  {(["services", "pods"] as const).map((each) => (
                    <button
                      key={each}
                      type="button"
                      role="radio"
                      aria-checked={this.view === each}
                      className={this.view === each ? styles.active : ""}
                      onClick={() => {
                        this.view = each;
                        this.nodeId = undefined;
                      }}
                    >
                      {each === "services" ? "Services" : "Pods"}
                    </button>
                  ))}
                </div>
                {this.view === "services" ? (
                  <div className={styles.segmented} role="radiogroup" aria-label="Scope">
                    {(["incident", "namespace"] as const).map((each) => (
                      <button
                        key={each}
                        type="button"
                        role="radio"
                        aria-checked={this.scope === each}
                        className={this.scope === each ? styles.active : ""}
                        onClick={() => (this.scope = each)}
                      >
                        {each === "incident" ? "This incident" : "Whole namespace"}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className={styles.segmented} role="radiogroup" aria-label="Group by">
                    {(["workload", "node"] as const).map((each) => (
                      <button
                        key={each}
                        type="button"
                        role="radio"
                        aria-checked={this.groupBy === each}
                        className={this.groupBy === each ? styles.active : ""}
                        onClick={() => (this.groupBy = each)}
                      >
                        By {each}
                      </button>
                    ))}
                  </div>
                )}
                <div className={styles.segmented} role="radiogroup" aria-label="Density">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={this.density === "standard"}
                    className={this.density === "standard" ? styles.active : ""}
                    onClick={() => {
                      this.density = "standard";
                      requestAnimationFrame(() => this.fit());
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
                      requestAnimationFrame(() => this.fit());
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
                <span className={styles.grow} />
                <button
                  type="button"
                  className={styles.toggle}
                  aria-pressed={this.panelOpen}
                  title={this.panelOpen ? "Hide details panel" : "Show details panel"}
                  onClick={() => {
                    this.panelOpen = !this.panelOpen;
                    requestAnimationFrame(() => this.fit());
                  }}
                  data-testid="service-map-toggle-panel"
                >
                  {this.panelOpen ? "Details ›" : "‹ Details"}
                </button>
              </div>
              <div
                ref={this.setCanvas}
                className={`${styles.canvas} ${this.dragging ? styles.dragging : ""}`}
                onPointerDown={this.onPointerDown}
                onPointerMove={this.onPointerMove}
                onPointerUp={this.onPointerUp}
                onPointerCancel={this.onPointerUp}
                role="presentation"
                data-testid="service-map-canvas"
              >
                {this.renderCanvas()}
                {this.renderSearchHud()}
                {this.renderFocusHud()}
                {this.renderLegend()}
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
                    disabled={this.layout.nodes.length === 0}
                    onClick={() => this.exportImage()}
                    data-testid="service-map-export-image"
                  >
                    Export PNG
                  </button>
                </div>
              </div>
              {incident && this.renderTimeline(incident)}
            </div>
            {this.panelOpen && this.renderPanel()}
          </div>
        </div>
      </TabLayout>
    );
  }
}

export const ServiceMap = withInjectables<Dependencies>(NonInjectedServiceMap, {
  getProps: (di, props) => ({
    ...props,
    subscribeStores: di.inject(subscribeStoresInjectable),
    showDetails: di.inject(showDetailsInjectable),
    clusterContext: di.inject(clusterFrameContextForNamespacedResourcesInjectable),
    apiManager: di.inject(apiManagerInjectable),
    customResourceDefinitionStore: di.inject(customResourceDefinitionStoreInjectable),
    apiKube: di.inject(apiKubeInjectable),
    apisixKeys: di.inject(topologyApisixKeysStorageInjectable),
    mutes: di.inject(serviceMapMutesStorageInjectable),
    callForLogs: di.inject(callForLogsInjectable),
    createPodLogsTab: di.inject(createPodLogsTabInjectable),
    podStore: di.inject(podStoreInjectable),
    sendCommand: di.inject(sendCommandInjectable),
    createResourceTab: di.inject(createResourceTabInjectable),
    createResourceTabStore: di.inject(createResourceTabStoreInjectable),
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
      events: di.inject(eventStoreInjectable),
    },
    clusterStores: {
      nodes: di.inject(nodeStoreInjectable),
      storageClasses: di.inject(storageClassStoreInjectable),
      ingressClasses: di.inject(ingressClassStoreInjectable),
    },
  }),
});
