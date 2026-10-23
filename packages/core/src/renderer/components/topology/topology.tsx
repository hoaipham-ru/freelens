/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { withInjectables } from "@ogre-tools/injectable-react";
import { computed, observable, reaction } from "mobx";
import { observer } from "mobx-react";
import React from "react";
import subscribeStoresInjectable from "../../kube-watch-api/subscribe-stores.injectable";
import configMapStoreInjectable from "../config-maps/store.injectable";
import podDisruptionBudgetStoreInjectable from "../config-pod-disruption-budgets/store.injectable";
import showDetailsInjectable from "../kube-detail-params/show-details.injectable";
import { TabLayout } from "../layout/tab-layout";
import { NamespaceSelectFilter } from "../namespaces/namespace-select-filter";
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
import styles from "./topology.module.scss";
import { buildTopology, layoutTopology, pathOf } from "./topology-model";

import type { KubeObject } from "@freelensapp/kube-object";

import type { SubscribableStore, SubscribeStores } from "../../kube-watch-api/kube-watch-api";
import type { ShowDetails } from "../kube-detail-params/show-details.injectable";
import type { LaidOutNode, RawObject, TopologyEdge, TopologyInput, TopologyMode } from "./topology-model";

type TopologyStore = SubscribableStore & { readonly contextItems: KubeObject[] };

interface Dependencies {
  subscribeStores: SubscribeStores;
  showDetails: ShowDetails;
  stores: Record<keyof TopologyInput, TopologyStore>;
}

const statusClass: Record<string, string> = { ok: "", warn: styles.warn, err: styles.err, idle: styles.idle };
const round = (value: number) => Math.round(value * 10) / 10;

function toRaw(object: KubeObject): RawObject {
  const plain = object.toPlainObject() as unknown as RawObject;

  return { ...plain, metadata: { ...plain.metadata, selfLink: object.selfLink } };
}

function podSelfLink(namespace: string, name: string) {
  return `/api/v1/namespaces/${namespace}/pods/${name}`;
}

@observer
class NonInjectedTopology extends React.Component<Dependencies> {
  private disposeWatch?: () => void;
  // mobx-react 9 forbids reading this.props inside a derivation; the stores come from DI and never change.
  private readonly stores: Dependencies["stores"];

  @observable accessor mode: TopologyMode = "architecture";
  @observable accessor selected: string | undefined = undefined;
  @observable accessor showExposes = true;
  @observable accessor showCalls = true;
  @observable accessor zoom = 1;

  constructor(props: Dependencies) {
    super(props);
    this.stores = props.stores;
  }

  componentDidMount() {
    this.disposeWatch = this.props.subscribeStores(Object.values(this.stores));
    // Re-fit when what is drawn changes shape: another namespace, another view.
    this.disposeFit = reaction(
      () => `${this.mode}:${this.graph.nodes.length}`,
      () => requestAnimationFrame(() => this.fit("width")),
      { fireImmediately: true },
    );
  }

  componentWillUnmount() {
    this.disposeWatch?.();
    this.disposeFit?.();
  }

  private readonly canvas = React.createRef<HTMLDivElement>();
  private disposeFit?: () => void;

  /**
   * Zoom to fit, never above 100%. The automatic fit only fits the width and stops at 60%, so
   * text stays readable and the map scrolls down; the Fit button fits everything, down to 30%.
   */
  fit(what: "width" | "all" = "all") {
    const element = this.canvas.current;

    if (!element || this.layout.width === 0) {
      return;
    }

    const byWidth = element.clientWidth / this.layout.width;
    const scale = what === "width" ? byWidth : Math.min(byWidth, element.clientHeight / this.layout.height);

    this.zoom = Math.max(what === "width" ? 0.6 : 0.3, Math.min(1, Math.floor(scale * 20) / 20));
  }

  @computed get input(): TopologyInput {
    const { stores } = this;
    const read = (key: keyof TopologyInput) => stores[key].contextItems.map(toRaw);

    return {
      ingresses: read("ingresses"),
      services: read("services"),
      deployments: read("deployments"),
      statefulSets: read("statefulSets"),
      daemonSets: read("daemonSets"),
      replicaSets: read("replicaSets"),
      cronJobs: read("cronJobs"),
      jobs: read("jobs"),
      pods: read("pods"),
      configMaps: read("configMaps"),
      persistentVolumeClaims: read("persistentVolumeClaims"),
      podDisruptionBudgets: read("podDisruptionBudgets"),
      networkPolicies: read("networkPolicies"),
    };
  }

  @computed get graph() {
    return buildTopology(this.input, this.mode);
  }

  @computed get visibleEdges(): TopologyEdge[] {
    return this.graph.edges.filter((edge) => (edge.type === "calls" ? this.showCalls : this.showExposes));
  }

  @computed get layout() {
    return layoutTopology({ ...this.graph, edges: this.visibleEdges });
  }

  @computed get path() {
    return pathOf(this.visibleEdges, this.selected);
  }

  setMode(mode: TopologyMode) {
    this.mode = mode;
    this.selected = mode === "network" && this.graph.nodes.some((n) => n.id === "outside") ? "outside" : undefined;
  }

  renderEdges() {
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

    return this.visibleEdges.map((edge) => {
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
      const className = [
        styles.edge,
        edge.type === "calls" ? styles.calls : styles.exposes,
        onPath ? styles.onPath : highlight ? styles.dimmed : "",
      ].join(" ");

      return (
        <g key={edge.id} className={className}>
          <path d={d} />
          <path d={arrow} className={styles.arrow} />
          <title>{`${edge.type}: ${edge.via}`}</title>
        </g>
      );
    });
  }

  renderNode(node: LaidOutNode) {
    const selected = this.selected === node.id;
    const dimmed = this.selected !== undefined && !this.path.nodes.has(node.id);
    const className = [
      styles.node,
      statusClass[node.status],
      selected ? styles.selected : "",
      dimmed ? styles.dimmed : "",
      node.outsideView ? styles.outsideView : "",
    ].join(" ");

    return (
      <button
        key={node.id}
        type="button"
        className={className}
        style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
        onClick={(event) => {
          event.stopPropagation();
          this.selected = selected ? undefined : node.id;
        }}
        data-testid={`topology-node-${node.id}`}
      >
        <span className={styles.nodeHead}>
          <span className={styles.kind}>{node.kind}</span>
          {node.flags.map((flag) => (
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
              {node.pods.slice(0, 12).map((pod) => (
                <span
                  key={pod.name}
                  className={`${styles.pod} ${statusClass[pod.status]}`}
                  title={`${pod.name}: ${pod.reason}`}
                />
              ))}
            </span>
          )}
        </span>
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

    const name = (id: string) => this.graph.nodes.find((n) => n.id === id);
    const incoming = this.visibleEdges.filter((e) => e.to === node.id);
    const outgoing = this.visibleEdges.filter((e) => e.from === node.id);
    const edgeRow = (edge: TopologyEdge, otherId: string) => {
      const other = name(otherId);

      return (
        <li key={edge.id} className={edge.inferred ? styles.inferred : ""}>
          <span className={styles.rowName}>
            {other
              ? `${other.namespace && other.namespace !== node.namespace ? `${other.namespace}/` : ""}${other.name}`
              : otherId}
          </span>
          <span className={styles.rowVia}>{edge.via}</span>
          <span className={styles.rowKind}>{edge.inferred ? "inferred" : other?.kind}</span>
        </li>
      );
    };

    return (
      <aside className={styles.details}>
        <header>
          <span className={styles.kind}>{node.kind}</span>
          <h2>{node.name}</h2>
          <span className={styles.summary}>{[node.namespace, node.summary].filter(Boolean).join(" · ")}</span>
        </header>
        {node.flags.map((flag) => (
          <p key={flag.text} className={styles.note}>
            {flag.detail}
          </p>
        ))}
        {node.outsideView && (
          <p className={styles.note}>
            This Service is in a namespace that isn't selected. Add the namespace to see what is behind it.
          </p>
        )}
        {incoming.length > 0 && (
          <section>
            <h3>Reached from</h3>
            <ul>{incoming.map((e) => edgeRow(e, e.from))}</ul>
          </section>
        )}
        {outgoing.length > 0 && (
          <section>
            <h3>
              {node.kind === "Service" || node.kind === "Ingress" || node.kind === "External" ? "Sends to" : "Talks to"}
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
        {node.kind !== "Pod" && node.pods.length > 0 && (
          <section>
            <h3>Pods</h3>
            <ul>
              {node.pods.map((pod) => (
                <li key={pod.name}>
                  <button
                    type="button"
                    className={styles.linkRow}
                    onClick={() => this.props.showDetails(podSelfLink(node.namespace, pod.name))}
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
        {node.selfLink && !node.outsideView && (
          <button type="button" className={styles.primary} onClick={() => this.props.showDetails(node.selfLink)}>
            Open details
          </button>
        )}
      </aside>
    );
  }

  render() {
    const { layout, graph } = this;
    const shown = graph.nodes.length;

    return (
      <TabLayout>
        <div className={styles.topology} data-testid="topology-page">
          <div className={styles.header}>
            <h5>Topology</h5>
            <span className={styles.count}>
              {shown} shown
              {this.mode === "architecture" && graph.hiddenCount > 0 ? ` · ${graph.hiddenCount} folded into cards` : ""}
              {this.selected ? "" : " · click an item to trace its path"}
            </span>
            <NamespaceSelectFilter id="topology-namespace-select-filter-input" />
          </div>
          <div className={styles.toolbar}>
            <div className={styles.segmented} role="radiogroup" aria-label="View">
              {(["architecture", "network"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={this.mode === mode}
                  className={this.mode === mode ? styles.active : ""}
                  onClick={() => this.setMode(mode)}
                >
                  {mode === "architecture" ? "Architecture" : "Network flow"}
                </button>
              ))}
            </div>
            <button
              type="button"
              aria-pressed={this.showExposes}
              className={`${styles.toggle} ${this.showExposes ? styles.active : ""}`}
              onClick={() => (this.showExposes = !this.showExposes)}
            >
              <span className={styles.legendExposes} />
              exposes
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
            <div className={styles.grow} />
            <div className={styles.zoom}>
              <button
                type="button"
                aria-label="Zoom out"
                onClick={() => (this.zoom = Math.max(0.4, round(this.zoom - 0.1)))}
              >
                −
              </button>
              <span>{Math.round(this.zoom * 100)}%</span>
              <button
                type="button"
                aria-label="Zoom in"
                onClick={() => (this.zoom = Math.min(1.6, round(this.zoom + 0.1)))}
              >
                +
              </button>
              <button type="button" className={styles.fit} onClick={() => this.fit()}>
                Fit
              </button>
            </div>
          </div>
          {graph.nodes.length > 150 && (
            <p className={styles.crowded}>
              {graph.nodes.length} items is a lot to read at once. Pick one or two namespaces to see how a tool is put
              together.
            </p>
          )}
          <div className={styles.body}>
            <div
              ref={this.canvas}
              className={styles.canvas}
              onClick={() => (this.selected = undefined)}
              role="presentation"
            >
              {graph.nodes.length === 0 ? (
                <p className={styles.empty}>Nothing to draw in the selected namespaces.</p>
              ) : (
                <div
                  className={styles.stage}
                  style={{ width: layout.width * this.zoom, height: layout.height * this.zoom }}
                >
                  <div
                    className={styles.scaled}
                    style={{ width: layout.width, height: layout.height, transform: `scale(${this.zoom})` }}
                  >
                    {layout.groups.map((group) => (
                      <div
                        key={group.id}
                        className={styles.group}
                        style={{ left: group.x, top: group.y, width: group.width, height: group.height }}
                      >
                        <span className={styles.groupLabel}>{group.label}</span>
                        <span className={styles.groupMeta}>{group.meta}</span>
                      </div>
                    ))}
                    <svg className={styles.edges} width={layout.width} height={layout.height} aria-hidden="true">
                      {this.renderEdges()}
                    </svg>
                    {layout.nodes.map((node) => this.renderNode(node))}
                  </div>
                </div>
              )}
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
