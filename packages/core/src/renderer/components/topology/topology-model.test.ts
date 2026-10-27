/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import {
  buildOverview,
  buildTopology,
  compactSizeOf,
  createReferenceFinder,
  findApisixAdmins,
  findApisixViewerKey,
  findServiceReferences,
  focusTopology,
  layoutTopology,
  parseApisixRoutes,
  pathOf,
  podStatusOf,
  resolveServiceHost,
  selectorMatches,
} from "./topology-model";

import type { RawObject, TopologyEdge, TopologyGraph, TopologyInput, TopologyNode } from "./topology-model";

const empty = (): TopologyInput => ({
  ingresses: [],
  services: [],
  deployments: [],
  statefulSets: [],
  daemonSets: [],
  replicaSets: [],
  cronJobs: [],
  jobs: [],
  pods: [],
  configMaps: [],
  persistentVolumeClaims: [],
  podDisruptionBudgets: [],
  networkPolicies: [],
});

const meta = (
  name: string,
  namespace = "dremio",
  labels: Record<string, string> = {},
  extra: Partial<RawObject["metadata"]> = {},
) => ({
  name,
  namespace,
  uid: `uid-${namespace}-${name}`,
  labels,
  ...extra,
});

const readyPod = (
  name: string,
  labels: Record<string, string>,
  owner: { kind: string; name: string },
  namespace = "dremio",
): RawObject => ({
  kind: "Pod",
  metadata: meta(name, namespace, labels, { ownerReferences: [{ ...owner, uid: `uid-${namespace}-${owner.name}` }] }),
  spec: {},
  status: { phase: "Running", containerStatuses: [{ ready: true, state: { running: {} } }] },
});

const statefulSet = (
  name: string,
  labels: Record<string, string>,
  replicas: number,
  podSpec: object = {},
): RawObject => ({
  kind: "StatefulSet",
  metadata: meta(name, "dremio", labels),
  spec: { replicas, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: podSpec } },
  status: { readyReplicas: replicas },
});

const dremioConf = (name: string): RawObject => ({
  kind: "ConfigMap",
  metadata: meta(name),
  data: {
    "dremio.conf":
      'services.coordinator.master.embedded-zookeeper.enabled: false\nzookeeper: "dremio-zookeeper-0.dremio-zookeeper-headless.dremio.svc:2181"\n',
  },
});

/** Shaped like the dremio Helm release: three Dremio roles, ZooKeeper, two Services each. */
function dremioNamespace(): TopologyInput {
  const app = (role: string) => ({ "app.kubernetes.io/name": "dremio", app: "dremio", role });
  const zk = { "app.kubernetes.io/name": "zookeeper", "app.kubernetes.io/component": "zookeeper" };
  const confVolume = (cm: string) => ({
    volumes: [{ name: "config", configMap: { name: cm } }],
    serviceAccountName: cm.replace("-dremio-conf", ""),
  });
  const input = empty();

  input.statefulSets = [
    statefulSet("dremio-coordinator", app("coordinator"), 1, confVolume("dremio-coordinator-dremio-conf")),
    {
      ...statefulSet(
        "dremio-master-coordinator",
        app("master"),
        1,
        confVolume("dremio-master-coordinator-dremio-conf"),
      ),
      spec: {
        replicas: 1,
        selector: { matchLabels: app("master") },
        template: { metadata: { labels: app("master") }, spec: confVolume("dremio-master-coordinator-dremio-conf") },
        volumeClaimTemplates: [{ metadata: { name: "data" } }],
      },
    },
    statefulSet("dremio-executor-default", app("executor"), 3, confVolume("dremio-executor-default-dremio-conf")),
    statefulSet("dremio-zookeeper", zk, 1, {
      volumes: [{ name: "scripts", configMap: { name: "dremio-zookeeper-scripts" } }],
    }),
  ];
  input.pods = [
    readyPod("dremio-coordinator-0", app("coordinator"), { kind: "StatefulSet", name: "dremio-coordinator" }),
    readyPod("dremio-master-coordinator-0", app("master"), { kind: "StatefulSet", name: "dremio-master-coordinator" }),
    readyPod("dremio-executor-default-0", app("executor"), { kind: "StatefulSet", name: "dremio-executor-default" }),
    readyPod("dremio-executor-default-1", app("executor"), { kind: "StatefulSet", name: "dremio-executor-default" }),
    readyPod("dremio-executor-default-2", app("executor"), { kind: "StatefulSet", name: "dremio-executor-default" }),
    readyPod("dremio-zookeeper-0", zk, { kind: "StatefulSet", name: "dremio-zookeeper" }),
  ].map((pod) => ({
    ...pod,
    spec: input.statefulSets.find((s) => pod.metadata.name.startsWith(s.metadata.name))?.spec.template.spec,
  }));
  input.services = [
    {
      kind: "Service",
      metadata: meta("dremio", "dremio", { "app.kubernetes.io/name": "dremio" }),
      spec: {
        type: "LoadBalancer",
        selector: { app: "dremio", role: "coordinator" },
        ports: [{ port: 9047 }, { port: 31010 }, { port: 32010 }],
      },
      status: { loadBalancer: {} },
    },
    {
      kind: "Service",
      metadata: meta("dremio-master", "dremio", { "app.kubernetes.io/name": "dremio" }),
      spec: { type: "ClusterIP", selector: { app: "dremio", role: "master" }, ports: [{ port: 9047 }] },
    },
    {
      kind: "Service",
      metadata: meta("dremio-headless", "dremio", { "app.kubernetes.io/name": "dremio" }),
      spec: { type: "ClusterIP", clusterIP: "None", selector: { app: "dremio" }, ports: [{ port: 9047 }] },
    },
    {
      kind: "Service",
      metadata: meta("dremio-zookeeper-headless", "dremio", zk),
      spec: {
        type: "ClusterIP",
        clusterIP: "None",
        selector: zk,
        ports: [{ port: 2181 }, { port: 2888 }, { port: 3888 }],
      },
    },
    {
      kind: "Service",
      metadata: meta("dremio-zookeeper", "dremio", zk),
      spec: { type: "ClusterIP", selector: zk, ports: [{ port: 2181 }] },
    },
  ];
  input.configMaps = [
    dremioConf("dremio-coordinator-dremio-conf"),
    dremioConf("dremio-master-coordinator-dremio-conf"),
    dremioConf("dremio-executor-default-dremio-conf"),
    { kind: "ConfigMap", metadata: meta("dremio-zookeeper-scripts"), data: { "init.sh": "echo zookeeper" } },
  ];
  input.podDisruptionBudgets = [
    {
      kind: "PodDisruptionBudget",
      metadata: meta("dremio-executor-default"),
      spec: { selector: { matchLabels: app("executor") } },
    },
  ];
  input.networkPolicies = [
    { kind: "NetworkPolicy", metadata: meta("dremio-zookeeper"), spec: { podSelector: { matchLabels: zk } } },
    { kind: "NetworkPolicy", metadata: meta("allow-all"), spec: { podSelector: {} } },
  ];

  return input;
}

describe("topology model", () => {
  describe("selectorMatches", () => {
    it("treats a Service selector map as matchLabels", () => {
      expect(selectorMatches({ app: "a" }, { app: "a", tier: "web" })).toBe(true);
      expect(selectorMatches({ app: "a" }, { app: "b" })).toBe(false);
    });

    it("selects nothing with an empty Service selector, everything with an empty LabelSelector", () => {
      expect(selectorMatches({}, { app: "a" })).toBe(false);
      expect(selectorMatches({}, { app: "a" }, true)).toBe(true);
      expect(selectorMatches({ matchLabels: {} }, { app: "a" })).toBe(true);
    });

    it("supports matchExpressions", () => {
      const selector = {
        matchExpressions: [
          { key: "tier", operator: "In", values: ["web", "api"] },
          { key: "canary", operator: "DoesNotExist" },
        ],
      };

      expect(selectorMatches(selector, { tier: "api" })).toBe(true);
      expect(selectorMatches(selector, { tier: "api", canary: "1" })).toBe(false);
      expect(selectorMatches(selector, { tier: "db" })).toBe(false);
    });
  });

  describe("findServiceReferences", () => {
    const known = new Set(["dremio/dremio-zookeeper", "kafka/kafka-bootstrap", "app/postgres"]);

    it("finds fully qualified names, including a pod behind a headless Service", () => {
      expect(
        findServiceReferences(
          'zookeeper: "dremio-zookeeper-0.dremio-zookeeper-headless.dremio.svc:2181"',
          "dremio",
          known,
        ),
      ).toEqual([{ namespace: "dremio", service: "dremio-zookeeper-headless", port: "2181" }]);
      expect(findServiceReferences("http://vault.vault.svc.cluster.local:8200/v1", "app", known)).toEqual([
        { namespace: "vault", service: "vault", port: "8200" },
      ]);
    });

    it("accepts short names only when that Service exists", () => {
      expect(findServiceReferences("postgresql://user@postgres:5432/db", "app", known)).toEqual([
        { namespace: "app", service: "postgres", port: "5432" },
      ]);
      expect(findServiceReferences("bootstrap.servers=kafka-bootstrap.kafka:9092", "app", known)).toEqual([
        { namespace: "kafka", service: "kafka-bootstrap", port: "9092" },
      ]);
      expect(findServiceReferences("timeout: 30s, retry:5, mode=fast host:8080", "app", known)).toEqual([]);
    });
  });

  describe("podStatusOf", () => {
    it("reports crash loops and image pull failures as errors", () => {
      const pod = (reason: string): RawObject => ({
        metadata: { name: "p" },
        status: { phase: "Pending", containerStatuses: [{ ready: false, state: { waiting: { reason } } }] },
      });

      expect(podStatusOf(pod("CrashLoopBackOff"))).toEqual({ name: "p", status: "err", reason: "CrashLoopBackOff" });
      expect(podStatusOf(pod("ImagePullBackOff")).status).toBe("err");
      expect(podStatusOf(pod("ContainerCreating")).status).toBe("warn");
    });
  });

  describe("architecture view of the dremio release", () => {
    const graph = buildTopology(dremioNamespace(), "architecture");
    const byName = (kind: string, name: string) => graph.nodes.find((n) => n.kind === kind && n.name === name);
    const edgesOf = (type: string) => graph.edges.filter((e) => e.type === type);

    it("shows Services and workloads, folding pods and config into the workload", () => {
      expect(graph.nodes.map((n) => `${n.kind}/${n.name}`).sort()).toEqual([
        "Service/dremio",
        "Service/dremio-headless",
        "Service/dremio-master",
        "Service/dremio-zookeeper",
        "Service/dremio-zookeeper-headless",
        "StatefulSet/dremio-coordinator",
        "StatefulSet/dremio-executor-default",
        "StatefulSet/dremio-master-coordinator",
        "StatefulSet/dremio-zookeeper",
      ]);
      expect(byName("StatefulSet", "dremio-executor-default")?.pods.map((p) => p.status)).toEqual(["ok", "ok", "ok"]);
      expect(byName("StatefulSet", "dremio-executor-default")?.summary).toBe("3/3 ready");
    });

    it("lists what each workload mounts and what protects it", () => {
      const master = byName("StatefulSet", "dremio-master-coordinator");
      const executor = byName("StatefulSet", "dremio-executor-default");
      const zookeeper = byName("StatefulSet", "dremio-zookeeper");

      expect(master?.attachments.map((a) => a.short)).toEqual(["cm", "pvc", "sa", "np"]);
      expect(executor?.attachments.find((a) => a.kind === "PodDisruptionBudget")?.name).toBe("dremio-executor-default");
      expect(zookeeper?.attachments.filter((a) => a.kind === "NetworkPolicy").map((a) => a.name)).toEqual([
        "dremio-zookeeper",
        "allow-all",
      ]);
    });

    it("connects Services to the workloads they select", () => {
      expect(
        edgesOf("exposes")
          .map((e) => `${e.from} -> ${e.to}`)
          .sort(),
      ).toEqual([
        "service/dremio/dremio -> statefulset/dremio/dremio-coordinator",
        "service/dremio/dremio-headless -> statefulset/dremio/dremio-coordinator",
        "service/dremio/dremio-headless -> statefulset/dremio/dremio-executor-default",
        "service/dremio/dremio-headless -> statefulset/dremio/dremio-master-coordinator",
        "service/dremio/dremio-master -> statefulset/dremio/dremio-master-coordinator",
        "service/dremio/dremio-zookeeper -> statefulset/dremio/dremio-zookeeper",
        "service/dremio/dremio-zookeeper-headless -> statefulset/dremio/dremio-zookeeper",
      ]);
    });

    it("infers that every Dremio role calls ZooKeeper, from dremio.conf", () => {
      const calls = edgesOf("calls");

      expect(calls.map((e) => e.from).sort()).toEqual([
        "statefulset/dremio/dremio-coordinator",
        "statefulset/dremio/dremio-executor-default",
        "statefulset/dremio/dremio-master-coordinator",
      ]);
      expect(new Set(calls.map((e) => e.to))).toEqual(new Set(["service/dremio/dremio-zookeeper-headless"]));
      expect(calls[0]).toMatchObject({
        inferred: true,
        via: ":2181 · dremio.conf in ConfigMap dremio-coordinator-dremio-conf",
      });
    });

    it("flags a LoadBalancer without an address", () => {
      expect(byName("Service", "dremio")).toMatchObject({ status: "warn", flags: [{ text: "IP pending" }] });
      expect(byName("Service", "dremio-zookeeper")?.flags).toEqual([]);
    });

    it("lays out groups by who calls whom and keeps nodes apart", () => {
      const layout = layoutTopology(graph);
      const group = (id: string) => layout.groups.find((g) => g.id === id);

      expect(layout.groups.map((g) => g.id).sort()).toEqual(["dremio/dremio", "dremio/zookeeper"]);
      expect(group("dremio/dremio")!.x).toBeLessThan(group("dremio/zookeeper")!.x);

      for (const a of layout.nodes) {
        for (const b of layout.nodes) {
          if (a !== b) {
            const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

            expect(overlap, `${a.id} overlaps ${b.id}`).toBe(false);
          }
        }
      }
    });
  });

  describe("layout", () => {
    it("draws every edge with right angles, from the side of its source to the side of its target", () => {
      const graph = buildTopology(dremioNamespace(), "architecture");
      const layout = layoutTopology(graph);
      const node = (id: string) => layout.nodes.find((n) => n.id === id)!;

      for (const edge of graph.edges) {
        const points = layout.routes[edge.id];
        const from = node(edge.from);
        const to = node(edge.to);

        expect(points.length, edge.id).toBeGreaterThanOrEqual(2);
        expect(points[0]).toEqual({ x: from.x + from.width, y: from.y + from.height / 2 });
        expect(points.at(-1)).toEqual({ x: to.x, y: to.y + to.height / 2 });

        for (let i = 1; i < points.length; i++) {
          const straight = points[i].x === points[i - 1].x || points[i].y === points[i - 1].y;

          expect(straight, `${edge.id} segment ${i}`).toBe(true);
        }
      }
    });

    it("runs the lines into one target together, bending at the same x", () => {
      const graph = buildTopology(dremioNamespace(), "architecture");
      const layout = layoutTopology(graph);
      const turns = graph.edges
        .filter((e) => e.to === "service/dremio/dremio-zookeeper-headless")
        .map((e) => layout.routes[e.id].at(-2)?.x);

      expect(turns.length).toBe(3);
      expect(new Set(turns).size).toBe(1);
    });
  });

  describe("network view of the dremio release", () => {
    const graph = buildTopology(dremioNamespace(), "network");

    it("starts outside the cluster and reaches each pod", () => {
      expect(graph.edges.filter((e) => e.from === "outside").map((e) => e.to)).toEqual(["service/dremio/dremio"]);
      expect(graph.nodes.find((n) => n.id === "outside")).toMatchObject({
        status: "warn",
        flags: [{ text: "no address" }],
      });
      expect(graph.edges.filter((e) => e.from === "service/dremio/dremio-headless").length).toBe(5);
    });

    it("draws the ZooKeeper calls from each Dremio pod", () => {
      const callers = graph.edges.filter((e) => e.type === "calls").map((e) => e.from);

      expect(callers.length).toBe(5);
      expect(callers.every((id) => id.startsWith("pod/dremio/dremio-"))).toBe(true);
    });

    it("lights up the path from outside to ZooKeeper", () => {
      const path = pathOf(graph.edges, "outside");

      expect([...path.nodes].sort()).toEqual([
        "outside",
        "pod/dremio/dremio-coordinator-0",
        "pod/dremio/dremio-zookeeper-0",
        "service/dremio/dremio",
        "service/dremio/dremio-zookeeper-headless",
      ]);
    });

    it("identifies upstream and downstream nodes in blast radius path tracing", () => {
      const path = pathOf(graph.edges, "service/dremio/dremio");

      expect(path.upstream.has("outside")).toBe(true);
      expect(path.downstream.has("pod/dremio/dremio-coordinator-0")).toBe(true);
      expect(path.nodes.has("service/dremio/dremio")).toBe(true);
    });
  });

  describe("other shapes", () => {
    it("follows Deployment -> ReplicaSet -> Pod and CronJob -> Job -> Pod", () => {
      const input = empty();
      const labels = { app: "api" };

      input.deployments = [
        {
          kind: "Deployment",
          metadata: meta("api", "app"),
          spec: { replicas: 2, template: { metadata: { labels } } },
          status: { readyReplicas: 0 },
        },
      ];
      input.replicaSets = [
        {
          kind: "ReplicaSet",
          metadata: meta("api-7d9f", "app", labels, {
            ownerReferences: [{ kind: "Deployment", name: "api", uid: "uid-app-api" }],
          }),
        },
      ];
      input.cronJobs = [
        {
          kind: "CronJob",
          metadata: meta("compaction", "app"),
          spec: {
            schedule: "*/30 * * * *",
            jobTemplate: { spec: { template: { metadata: { labels: { app: "compaction" } } } } },
          },
        },
      ];
      input.jobs = [
        {
          kind: "Job",
          metadata: meta(
            "compaction-1",
            "app",
            {},
            { ownerReferences: [{ kind: "CronJob", name: "compaction", uid: "uid-app-compaction" }] },
          ),
          status: { failed: 1 },
        },
      ];
      input.pods = [
        {
          kind: "Pod",
          metadata: meta("api-7d9f-x8p2n", "app", labels, {
            ownerReferences: [{ kind: "ReplicaSet", name: "api-7d9f", uid: "uid-app-api-7d9f" }],
          }),
          status: {
            phase: "Running",
            containerStatuses: [{ ready: false, state: { waiting: { reason: "CrashLoopBackOff" } } }],
          },
        },
        {
          kind: "Pod",
          metadata: meta(
            "compaction-1-abcde",
            "app",
            { app: "compaction" },
            { ownerReferences: [{ kind: "Job", name: "compaction-1", uid: "uid-app-compaction-1" }] },
          ),
          status: { phase: "Failed" },
        },
      ];

      const graph = buildTopology(input, "architecture");
      const api = graph.nodes.find((n) => n.name === "api");
      const cron = graph.nodes.find((n) => n.name === "compaction");

      expect(api).toMatchObject({ kind: "Deployment", status: "err", summary: "0/2 ready" });
      expect(api?.pods).toEqual([{ name: "api-7d9f-x8p2n", status: "err", reason: "CrashLoopBackOff" }]);
      expect(cron?.pods.map((p) => p.name)).toEqual(["compaction-1-abcde"]);
      expect(graph.nodes.some((n) => n.kind === "Job")).toBe(false);
    });

    it("adds a Service named by DNS but not visible as a card outside the view", () => {
      const input = empty();

      input.deployments = [
        {
          kind: "Deployment",
          metadata: meta("auth-service", "app"),
          spec: {
            replicas: 1,
            template: {
              metadata: { labels: { app: "auth" } },
              spec: {
                containers: [{ name: "c", env: [{ name: "VAULT_ADDR", value: "http://vault.vault.svc:8200" }] }],
              },
            },
          },
          status: { readyReplicas: 1 },
        },
      ];

      const graph = buildTopology(input, "architecture");

      expect(graph.nodes.find((n) => n.id === "service/vault/vault")).toMatchObject({
        outsideView: true,
        group: "ns:vault",
        status: "warn",
        flags: [{ text: "not found" }],
      });
      expect(graph.edges).toEqual([
        expect.objectContaining({
          from: "deployment/app/auth-service",
          to: "service/vault/vault",
          type: "calls",
          label: "calls :8200",
          via: ":8200 · env VAULT_ADDR",
        }),
      ]);
    });

    it("wraps unrelated groups into more columns instead of one tall stack", () => {
      const input = empty();

      input.deployments = Array.from({ length: 30 }, (_, i) => ({
        kind: "Deployment",
        metadata: meta(`app-${i}`, "many"),
        spec: { replicas: 1, template: { metadata: { labels: { app: `app-${i}` } } } },
        status: { readyReplicas: 1 },
      }));

      const layout = layoutTopology(buildTopology(input, "architecture"));

      expect(new Set(layout.groups.map((g) => g.x)).size).toBeGreaterThan(1);
      expect(layout.height).toBeLessThanOrEqual(1400 + 200);
    });

    it("ignores a workload naming its own Service", () => {
      const input = empty();
      const labels = { app: "web" };

      input.services = [
        { kind: "Service", metadata: meta("web", "app"), spec: { selector: labels, ports: [{ port: 80 }] } },
      ];
      input.deployments = [
        {
          kind: "Deployment",
          metadata: meta("web", "app"),
          spec: {
            replicas: 1,
            template: {
              metadata: { labels },
              spec: { containers: [{ name: "c", env: [{ name: "PUBLIC_URL", value: "http://web.app.svc" }] }] },
            },
          },
          status: { readyReplicas: 1 },
        },
      ];

      expect(buildTopology(input, "architecture").edges.map((e) => e.type)).toEqual(["exposes"]);
    });
  });
  describe("across namespaces", () => {
    /**
     * Shaped like the cluster this was built against: Istio's ingress gateway in istio-system,
     * a shared Gateway in apisix, a VirtualService in nexus3-psql bound to it, one in airflow
     * bound to a Gateway that doesn't exist, and Airflow reading Dremio's address from env.
     */
    function cluster(): TopologyInput {
      const input = dremioNamespace();
      const gatewayLabels = { app: "istio-ingressgateway", istio: "ingressgateway" };

      input.deployments = [
        {
          kind: "Deployment",
          metadata: meta("istio-ingressgateway", "istio-system", gatewayLabels),
          spec: { replicas: 1, template: { metadata: { labels: gatewayLabels } } },
          status: { readyReplicas: 1 },
        },
        {
          kind: "Deployment",
          metadata: meta("nexus3", "nexus3-psql"),
          spec: { replicas: 1, template: { metadata: { labels: { app: "nexus3" } } } },
          status: { readyReplicas: 1 },
        },
        {
          kind: "Deployment",
          metadata: meta("airflow-scheduler", "airflow"),
          spec: {
            replicas: 1,
            template: {
              metadata: { labels: { app: "airflow", component: "scheduler" } },
              spec: {
                containers: [
                  { name: "scheduler", env: [{ name: "DREMIO_HOST", value: "dremio.dremio.svc.cluster.local:31010" }] },
                ],
              },
            },
          },
          status: { readyReplicas: 1 },
        },
        {
          kind: "Deployment",
          metadata: meta("airflow-api-server", "airflow"),
          spec: { replicas: 1, template: { metadata: { labels: { app: "airflow", component: "api" } } } },
          status: { readyReplicas: 1 },
        },
      ];
      input.replicaSets = input.deployments.map((d) => ({
        kind: "ReplicaSet",
        metadata: meta(
          `${d.metadata.name}-rs`,
          d.metadata.namespace,
          {},
          {
            ownerReferences: [{ kind: "Deployment", name: d.metadata.name, uid: d.metadata.uid }],
          },
        ),
      }));
      input.pods = [
        ...input.pods,
        ...input.deployments.map((d) => ({
          ...readyPod(
            `${d.metadata.name}-rs-x1`,
            d.spec.template.metadata.labels,
            { kind: "ReplicaSet", name: `${d.metadata.name}-rs` },
            d.metadata.namespace,
          ),
          spec: d.spec.template.spec ?? {},
        })),
      ];
      input.services = [
        ...input.services,
        {
          kind: "Service",
          metadata: meta("istio-ingressgateway", "istio-system"),
          spec: { type: "LoadBalancer", selector: gatewayLabels, ports: [{ port: 80 }, { port: 443 }] },
          status: { loadBalancer: { ingress: [{ ip: "192.168.18.37" }] } },
        },
        {
          kind: "Service",
          metadata: meta("nexus3", "nexus3-psql"),
          spec: { type: "ClusterIP", selector: { app: "nexus3" }, ports: [{ port: 8081 }] },
        },
        {
          kind: "Service",
          metadata: meta("airflow-api-server", "airflow"),
          spec: { type: "ClusterIP", selector: { app: "airflow", component: "api" }, ports: [{ port: 8080 }] },
        },
      ];
      input.gateways = [
        {
          kind: "Gateway",
          metadata: meta("apisix-gateway", "apisix"),
          spec: {
            selector: { istio: "ingressgateway" },
            servers: [{ hosts: ["nexus.paraline.io", "dremio.paraline.io"], port: { number: 80, protocol: "HTTP" } }],
          },
        },
      ];
      input.virtualServices = [
        {
          kind: "VirtualService",
          metadata: meta("nexus3-psql-vs", "nexus3-psql"),
          spec: {
            gateways: ["apisix/apisix-gateway"],
            hosts: ["nexus.paraline.io"],
            http: [
              { route: [{ destination: { host: "nexus3.nexus3-psql.svc.cluster.local", port: { number: 8081 } } }] },
            ],
          },
        },
        {
          kind: "VirtualService",
          metadata: meta("airflow-vs", "airflow"),
          spec: {
            gateways: ["airflow-gateway"],
            hosts: ["airflow-paraline.vmgmedia.vn"],
            http: [
              {
                route: [
                  { destination: { host: "airflow-api-server.airflow.svc.cluster.local", port: { number: 8080 } } },
                ],
              },
            ],
          },
        },
      ];

      return input;
    }

    it("resolves Istio destination hosts", () => {
      const known = new Set(["shop/cart"]);

      expect(resolveServiceHost("cart", "shop", known)).toEqual({ namespace: "shop", service: "cart" });
      expect(resolveServiceHost("cart.shop", "web", known)).toEqual({ namespace: "shop", service: "cart" });
      expect(resolveServiceHost("cart.shop.svc.cluster.local", "web", known)).toEqual({
        namespace: "shop",
        service: "cart",
      });
      expect(resolveServiceHost("api.example.com", "web", known)).toBeUndefined();
    });

    it("follows traffic from outside through the Istio gateway to the pod", () => {
      const graph = buildTopology(cluster(), "network");
      const path = pathOf(graph.edges, "virtualservice/nexus3-psql/nexus3-psql-vs");

      expect([...path.nodes].sort()).toEqual([
        "gateway/apisix/apisix-gateway",
        "outside",
        "pod/nexus3-psql/nexus3-rs-x1",
        "service/istio-system/istio-ingressgateway",
        "service/nexus3-psql/nexus3",
        "virtualservice/nexus3-psql/nexus3-psql-vs",
      ]);
      expect(graph.edges.find((e) => e.from === "outside" && e.to.includes("istio-ingressgateway"))?.label).toBe(
        "192.168.18.37",
      );
      expect(graph.edges.find((e) => e.to === "gateway/apisix/apisix-gateway")?.label).toBe("routes :80");
    });

    it("flags a VirtualService bound to a Gateway that doesn't exist", () => {
      const graph = buildTopology(cluster(), "architecture");

      expect(graph.nodes.find((n) => n.id === "virtualservice/airflow/airflow-vs")).toMatchObject({
        status: "err",
        flags: [{ text: "gateway missing" }],
        group: "airflow/airflow-api-server",
      });
      expect(graph.edges.some((e) => e.to === "virtualservice/airflow/airflow-vs")).toBe(false);
    });

    it("keeps the other end of links into and out of the selected namespace", () => {
      const graph = focusTopology(buildTopology(cluster(), "architecture"), ["dremio"]);
      const caller = graph.nodes.find((n) => n.id === "deployment/airflow/airflow-scheduler");

      expect(caller).toMatchObject({ outsideView: true, group: "ns:airflow", groupLabel: "airflow" });
      expect(graph.edges.find((e) => e.from === caller?.id)).toMatchObject({
        to: "service/dremio/dremio",
        type: "calls",
        label: "calls :31010",
      });
      // Nothing else from airflow: the rest of that namespace isn't linked to dremio.
      expect(graph.nodes.filter((n) => n.namespace === "airflow").map((n) => n.name)).toEqual(["airflow-scheduler"]);
    });

    it("shows a pod from another namespace as its workload in the network view", () => {
      const graph = focusTopology(buildTopology(cluster(), "network"), ["dremio"]);

      expect(graph.nodes.some((n) => n.id === "pod/airflow/airflow-scheduler-rs-x1")).toBe(false);
      expect(graph.edges.find((e) => e.to === "service/dremio/dremio" && e.type === "calls")?.from).toBe(
        "deployment/airflow/airflow-scheduler",
      );
    });

    it("brings in the whole entry chain from other namespaces", () => {
      const graph = focusTopology(buildTopology(cluster(), "network"), ["nexus3-psql"]);

      expect(
        graph.nodes
          .filter((n) => n.outsideView)
          .map((n) => n.id)
          .sort(),
      ).toEqual(["gateway/apisix/apisix-gateway", "service/istio-system/istio-ingressgateway"]);
      expect(graph.nodes.some((n) => n.id === "outside")).toBe(true);
      expect(
        graph.edges
          .filter((e) => e.type === "routes")
          .map((e) => `${e.from} -> ${e.to}`)
          .sort(),
      ).toEqual([
        "gateway/apisix/apisix-gateway -> virtualservice/nexus3-psql/nexus3-psql-vs",
        "outside -> service/istio-system/istio-ingressgateway",
        "service/istio-system/istio-ingressgateway -> gateway/apisix/apisix-gateway",
        "virtualservice/nexus3-psql/nexus3-psql-vs -> service/nexus3-psql/nexus3",
      ]);
      // The ingress gateway's own pods are not part of this namespace's story.
      expect(graph.nodes.some((n) => n.id.startsWith("pod/istio-system/"))).toBe(false);
    });

    it("sums the links up per namespace in the overview", () => {
      const overview = buildOverview(buildTopology(cluster(), "network"));
      const links = overview.edges.map((e) => `${e.from} -> ${e.to} (${e.label})`).sort();

      expect(overview.nodes.map((n) => n.id).sort()).toEqual([
        "namespace/airflow",
        "namespace/apisix",
        "namespace/dremio",
        "namespace/istio-system",
        "namespace/nexus3-psql",
        "outside",
      ]);
      expect(links).toEqual([
        "namespace/airflow -> namespace/dremio (calls :31010)",
        "namespace/apisix -> namespace/nexus3-psql (routes nexus.paraline.io)",
        "namespace/istio-system -> namespace/apisix (routes :80)",
        "outside -> namespace/dremio (LoadBalancer :9047 +2)",
        "outside -> namespace/istio-system (192.168.18.37)",
      ]);
      expect(overview.nodes.find((n) => n.id === "namespace/airflow")).toMatchObject({
        status: "err",
        summary: "2 workloads · 2 pods",
        flags: [{ text: "gateway missing" }],
      });
      expect(overview.nodes.find((n) => n.id === "namespace/apisix")?.hosts).toEqual([
        "nexus.paraline.io",
        "dremio.paraline.io",
      ]);
    });

    it("lays the overview out from outside inwards, with unlinked namespaces apart", () => {
      const input = cluster();

      input.deployments.push({
        kind: "Deployment",
        metadata: meta("lonely", "sandbox"),
        spec: { replicas: 1, template: { metadata: { labels: { app: "lonely" } } } },
        status: { readyReplicas: 1 },
      });

      const layout = layoutTopology(buildOverview(buildTopology(input, "network")));
      const x = (id: string) => layout.nodes.find((n) => n.id === id)?.x ?? -1;

      expect(x("outside")).toBeLessThan(x("namespace/istio-system"));
      expect(x("namespace/istio-system")).toBeLessThan(x("namespace/apisix"));
      expect(x("namespace/apisix")).toBeLessThan(x("namespace/nexus3-psql"));
      expect(layout.groups.map((g) => g.id)).toEqual(["loose"]);
      expect(layout.nodes.find((n) => n.id === "namespace/sandbox")?.y).toBeGreaterThan(
        Math.max(...layout.nodes.filter((n) => n.id !== "namespace/sandbox").map((n) => n.y)),
      );
    });

    it("takes spec.externalIPs as the address of a LoadBalancer", () => {
      const input = cluster();
      const gateway = input.services.find((s) => s.metadata.name === "istio-ingressgateway");

      if (gateway) {
        gateway.status = { loadBalancer: {} };
        gateway.spec.externalIPs = ["192.168.18.37", "192.168.18.38"];
      }

      const graph = buildTopology(input, "network");

      expect(graph.nodes.find((n) => n.id === "service/istio-system/istio-ingressgateway")?.flags).toEqual([]);
      expect(graph.edges.find((e) => e.to === "service/istio-system/istio-ingressgateway")?.label).toBe(
        "192.168.18.37 +1",
      );
    });

    it("ignores Grafana dashboards and the API server when inferring calls", () => {
      const input = empty();

      input.configMaps = [
        {
          kind: "ConfigMap",
          metadata: meta("istio-services-grafana-dashboards", "monitoring", { grafana_dashboard: "1" }),
          data: { "istio-service-dashboard.json": '{"expr": "details.default.svc.cluster.local"}' },
        },
        {
          kind: "ConfigMap",
          metadata: meta("prometheus", "monitoring"),
          data: { "prometheus.yml": "api_server: https://kubernetes.default.svc:443" },
        },
      ];
      input.deployments = [
        {
          kind: "Deployment",
          metadata: meta("grafana", "monitoring"),
          spec: {
            replicas: 1,
            template: {
              metadata: { labels: { app: "grafana" } },
              spec: {
                volumes: [
                  { name: "d", configMap: { name: "istio-services-grafana-dashboards" } },
                  { name: "p", configMap: { name: "prometheus" } },
                ],
              },
            },
          },
          status: { readyReplicas: 1 },
        },
      ];

      expect(buildTopology(input, "architecture").edges).toEqual([]);
    });

    it("remembers what it found in a text, until the Services change", () => {
      const find = createReferenceFinder();
      const text = "http://postgres:5432";
      const first = find(text, "app", new Set(["app/postgres"]));

      expect(find(text, "app", new Set(["app/postgres"]))).toBe(first);
      expect(find(text, "app", new Set(["app/mysql"]))).toEqual([]);
    });
  });
  describe("APISIX", () => {
    const apisixLabels = { "app.kubernetes.io/instance": "apisix", "app.kubernetes.io/name": "apisix" };

    it("finds the Admin API Service", () => {
      const services: RawObject[] = [
        {
          kind: "Service",
          metadata: meta("apisix-admin", "apisix"),
          spec: { selector: apisixLabels, ports: [{ port: 9180 }] },
        },
        {
          kind: "Service",
          metadata: meta("apisix-gateway", "apisix"),
          spec: { selector: apisixLabels, ports: [{ port: 80 }] },
        },
        { kind: "Service", metadata: meta("other", "x"), spec: { selector: { app: "x" }, ports: [{ port: 9180 }] } },
      ];

      expect(findApisixAdmins(services)).toEqual([{ namespace: "apisix", name: "apisix-admin", port: 9180 }]);
    });

    it("takes the viewer key from the APISIX ConfigMap, never the admin key", () => {
      const configMap = (yamlText: string, namespace = "apisix"): RawObject => ({
        kind: "ConfigMap",
        metadata: meta("apisix", namespace),
        data: { "config.yaml": yamlText },
      });
      const v3 = [
        "deployment:",
        "  role: traditional",
        "  admin:",
        "    allow_admin:",
        "      - 0.0.0.0/0",
        "    admin_key:",
        '      - name: "admin"',
        "        key: fixture-admin-value",
        "        role: admin",
        '      - name: "viewer"',
        "        key: fixture-viewer-value",
        "        role: viewer",
      ].join("\n");

      expect(findApisixViewerKey([configMap(v3)], "apisix")).toBe("fixture-viewer-value");
      expect(findApisixViewerKey([configMap(v3, "other")], "apisix")).toBeUndefined();
      expect(
        findApisixViewerKey([configMap(v3.replace("key: fixture-viewer-value", "key: ${{VIEWER_KEY}}"))], "apisix"),
      ).toBeUndefined();
      expect(findApisixViewerKey([configMap(v3.replace("role: viewer", "role: admin"))], "apisix")).toBeUndefined();
      expect(findApisixViewerKey([configMap("admin_key: [unclosed")], "apisix")).toBeUndefined();
    });

    it("reads routes in the v3 and v2 shapes, with every way to give an upstream", () => {
      const v3 = {
        total: 4,
        list: [
          {
            key: "/apisix/routes/15",
            value: {
              id: "15",
              name: "Dremio route ",
              host: "dremio.paraline.io",
              uri: "/*",
              upstream: { nodes: [{ host: "dremio.dremio.svc.cluster.local", port: 9047, weight: 1 }] },
            },
          },
          {
            value: {
              id: "82",
              hosts: ["nexus.paraline.io"],
              uris: ["/*"],
              plugins: { "proxy-rewrite": { headers: { set: { "X-Forwarded-Proto": "https" } } } },
              upstream: { nodes: { "nexus3-psql.nexus3-psql.svc.cluster.local:8081": 1 } },
            },
          },
          { value: { id: "7", uri: "/api/*", upstream_id: "u1", status: 0 } },
          { value: { id: "8", host: "k8s.example.com", service_id: "s1" } },
        ],
      };
      const upstreams = { list: [{ value: { id: "u1", nodes: [{ host: "10.0.0.5", port: 80 }] } }] };
      const services = {
        list: [{ value: { id: "s1", upstream: { discovery_type: "kubernetes", service_name: "shop/cart:http" } } }],
      };
      const routes = parseApisixRoutes(v3, upstreams, services);

      expect(routes).toEqual([
        {
          id: "15",
          name: "Dremio route",
          hosts: ["dremio.paraline.io"],
          uris: ["/*"],
          disabled: false,
          plugins: [],
          upstreams: [{ host: "dremio.dremio.svc.cluster.local", port: 9047 }],
        },
        {
          id: "82",
          name: "",
          hosts: ["nexus.paraline.io"],
          uris: ["/*"],
          disabled: false,
          plugins: ["proxy-rewrite"],
          upstreams: [{ host: "nexus3-psql.nexus3-psql.svc.cluster.local", port: 8081 }],
        },
        {
          id: "7",
          name: "",
          hosts: [],
          uris: ["/api/*"],
          disabled: true,
          plugins: [],
          upstreams: [{ host: "10.0.0.5", port: 80 }],
        },
        {
          id: "8",
          name: "",
          hosts: ["k8s.example.com"],
          uris: [],
          disabled: false,
          plugins: [],
          upstreams: [{ host: "cart.shop.svc", port: undefined }],
        },
      ]);
      expect(parseApisixRoutes({ node: { nodes: [{ value: { id: "1", uri: "/" } }] } }).map((r) => r.id)).toEqual([
        "1",
      ]);
      expect(parseApisixRoutes(undefined)).toEqual([]);
    });

    function withApisix(): TopologyInput {
      const input = empty();
      const gatewayLabels = { istio: "ingressgateway" };

      input.services = [
        {
          kind: "Service",
          metadata: meta("istio-ingressgateway", "istio-system"),
          spec: {
            type: "LoadBalancer",
            selector: gatewayLabels,
            externalIPs: ["192.168.18.37"],
            ports: [{ port: 80 }],
          },
        },
        {
          kind: "Service",
          metadata: meta("apisix-admin", "apisix"),
          spec: { selector: apisixLabels, ports: [{ port: 9180 }] },
        },
        {
          kind: "Service",
          metadata: meta("apisix-gateway", "apisix"),
          spec: { selector: apisixLabels, ports: [{ port: 80 }] },
        },
        {
          kind: "Service",
          metadata: meta("dremio", "dremio"),
          spec: { selector: { app: "dremio" }, ports: [{ port: 9047 }] },
        },
        {
          kind: "Service",
          metadata: meta("hanas-gateway", "hanas"),
          spec: { selector: { app: "hanas" }, ports: [{ port: 8080 }] },
        },
      ];
      input.pods = [
        readyPod("istio-ingressgateway-0", gatewayLabels, { kind: "ReplicaSet", name: "x" }, "istio-system"),
        readyPod("apisix-0", apisixLabels, { kind: "ReplicaSet", name: "apisix" }, "apisix"),
        readyPod("dremio-coordinator-0", { app: "dremio" }, { kind: "StatefulSet", name: "dremio-coordinator" }),
        readyPod("hanas-0", { app: "hanas" }, { kind: "ReplicaSet", name: "hanas" }, "hanas"),
      ];
      input.gateways = [
        {
          kind: "Gateway",
          metadata: meta("apisix-gateway", "apisix"),
          spec: { selector: gatewayLabels, servers: [{ hosts: ["dremio.paraline.io"], port: { number: 80 } }] },
        },
      ];
      input.virtualServices = [
        {
          kind: "VirtualService",
          metadata: meta("dremio-vs", "apisix"),
          spec: {
            gateways: ["apisix-gateway"],
            hosts: ["dremio.paraline.io"],
            http: [
              { route: [{ destination: { host: "apisix-gateway.apisix.svc.cluster.local", port: { number: 80 } } }] },
            ],
          },
        },
      ];
      input.apisix = [
        {
          namespace: "apisix",
          adminService: "apisix-admin",
          routes: [
            {
              id: "15",
              name: "Dremio route",
              hosts: ["dremio.paraline.io"],
              uris: ["/*"],
              disabled: false,
              plugins: [],
              upstreams: [{ host: "dremio.dremio.svc.cluster.local", port: 9047 }],
            },
            {
              id: "35",
              name: "Portal-hanas-inject",
              hosts: ["airflow.paraline.io", "dremio.paraline.io"],
              uris: ["/portal/*"],
              disabled: false,
              plugins: [],
              upstreams: [{ host: "hanas-gateway.hanas.svc.cluster.local", port: 8080 }],
            },
            {
              id: "19",
              name: "Nifi route",
              hosts: ["nifi-paraline.vmgmedia.vn"],
              uris: ["/*"],
              disabled: false,
              plugins: [],
              upstreams: [{ host: "nifi.nifi.svc.cluster.local", port: 8443 }],
            },
          ],
        },
      ];

      return input;
    }

    it("puts APISIX routes between its gateway Service and the apps", () => {
      const graph = buildTopology(withApisix(), "architecture");
      const routes = graph.edges.filter((e) => e.from.startsWith("apisixroute/") || e.to.startsWith("apisixroute/"));

      expect(routes.map((e) => `${e.from} -> ${e.to} (${e.label})`).sort()).toEqual([
        "apisixroute/apisix/15 -> service/dremio/dremio (routes :9047)",
        "apisixroute/apisix/35 -> service/hanas/hanas-gateway (routes :8080)",
        "service/apisix/apisix-gateway -> apisixroute/apisix/15 (routes dremio.paraline.io)",
        "service/apisix/apisix-gateway -> apisixroute/apisix/19 (routes nifi-paraline.vmgmedia.vn)",
        "service/apisix/apisix-gateway -> apisixroute/apisix/35 (routes airflow.paraline.io +1 /portal/*)",
      ]);
      expect(graph.nodes.find((n) => n.id === "apisixroute/apisix/19")).toMatchObject({
        status: "err",
        flags: [{ text: "no such Service" }],
      });
    });

    it("follows dremio.paraline.io from outside through Istio and APISIX to Dremio", () => {
      const graph = focusTopology(buildTopology(withApisix(), "network"), ["dremio"]);
      const path = pathOf(graph.edges, "pod/dremio/dremio-coordinator-0");

      expect([...path.nodes].sort()).toEqual([
        "apisixroute/apisix/15",
        "gateway/apisix/apisix-gateway",
        "outside",
        "pod/dremio/dremio-coordinator-0",
        "service/apisix/apisix-gateway",
        "service/dremio/dremio",
        "service/istio-system/istio-ingressgateway",
        "virtualservice/apisix/dremio-vs",
      ]);
      // The /portal/* route goes elsewhere: not part of Dremio's story.
      expect(graph.nodes.some((n) => n.id === "apisixroute/apisix/35")).toBe(false);
    });

    it("keeps only the routes for the app's own hosts on a shared gateway", () => {
      const input = withApisix();

      input.virtualServices?.push({
        kind: "VirtualService",
        metadata: meta("superset-vs", "apisix"),
        spec: {
          gateways: ["apisix-gateway"],
          hosts: ["superset.paraline.io"],
          http: [
            { route: [{ destination: { host: "apisix-gateway.apisix.svc.cluster.local", port: { number: 80 } } }] },
          ],
        },
      });

      const graph = focusTopology(buildTopology(input, "network"), ["dremio"]);

      expect(graph.nodes.some((n) => n.id === "virtualservice/apisix/dremio-vs")).toBe(true);
      expect(graph.nodes.some((n) => n.id === "virtualservice/apisix/superset-vs")).toBe(false);
    });

    it("stacks multi-hop upstream entry chains vertically in a single left column", () => {
      const graph = focusTopology(buildTopology(withApisix(), "network"), ["dremio"]);
      const layout = layoutTopology(graph);
      const byId = new Map(layout.nodes.map((n) => [n.id, n]));
      const chain = [
        "outside",
        "service/istio-system/istio-ingressgateway",
        "gateway/apisix/apisix-gateway",
        "virtualservice/apisix/dremio-vs",
        "service/apisix/apisix-gateway",
        "apisixroute/apisix/15",
      ];
      const centres = new Set(chain.map((id) => byId.get(id)!.x + byId.get(id)!.width / 2));

      expect(centres.size).toBe(1);
      for (let i = 1; i < chain.length; i++) {
        const prev = byId.get(chain[i - 1])!;
        const curr = byId.get(chain[i])!;

        expect(curr.y).toBeGreaterThan(prev.y);
      }
      expect(byId.get("service/dremio/dremio")!.x).toBeGreaterThan(byId.get("apisixroute/apisix/15")!.x);
    });
  });
});

describe("layoutTopology on awkward graphs", () => {
  const card = (id: string, kind: string, group: string, outsideView = false): TopologyNode => ({
    id,
    kind,
    name: id,
    namespace: outsideView ? "other" : "main",
    group,
    groupLabel: group,
    status: "ok",
    summary: "",
    flags: [],
    pods: [],
    attachments: [],
    hosts: [],
    outsideView,
    column: 0,
  });
  const link = (from: string, to: string, type: TopologyEdge["type"] = "routes"): TopologyEdge => ({
    id: `${type}:${from}->${to}`,
    from,
    to,
    type,
    label: "",
    via: "",
    inferred: false,
    count: 1,
  });
  const graphOf = (nodes: TopologyNode[], edges: TopologyEdge[]): TopologyGraph => ({
    nodes,
    edges,
    hiddenCount: 0,
    collapsed: [],
    objectCounts: {},
  });
  const expectDrawable = (graph: TopologyGraph) => {
    const layout = layoutTopology(graph);
    const numbers = [
      layout.width,
      layout.height,
      ...layout.nodes.flatMap((n) => [n.x, n.y, n.width, n.height]),
      ...layout.groups.flatMap((g) => [g.x, g.y, g.width, g.height]),
      ...Object.values(layout.routes).flatMap((points) => points.flatMap((p) => [p.x, p.y])),
    ];

    expect(numbers.every(Number.isFinite)).toBe(true);

    for (const edge of graph.edges) {
      expect(layout.routes[edge.id]?.length, edge.id).toBeGreaterThanOrEqual(2);
    }
  };

  it("does not crash when a line leaves a box and comes back to it", () => {
    // The Topology page crashed with "Not possible to find intersection inside of the rectangle".
    expectDrawable(
      graphOf(
        [
          card("n1", "APISIX route", "ns:other", true),
          card("n2", "VirtualService", "main/x"),
          card("n4", "Pod", "ns:other", true),
        ],
        [link("n2", "n1"), link("n4", "n2", "calls"), link("n2", "n1", "calls"), link("n1", "n2", "calls")],
      ),
    );
  });

  it("does not crash when several lines join the same two cards, or run both ways between them", () => {
    expectDrawable(
      graphOf(
        [
          card("n1", "Pod", "ns:a", true),
          card("n3", "VirtualService", "ns:a", true),
          card("n4", "Ingress", "ns:b", true),
        ],
        [link("n1", "n3", "exposes"), link("n1", "n4", "exposes"), link("n4", "n1"), link("n1", "n4")],
      ),
    );
  });

  it("draws every line of a link that runs both ways between two cards", () => {
    const graph = graphOf(
      [card("a", "Service", "main/x"), card("b", "Pod", "main/y")],
      [link("a", "b"), link("b", "a", "calls")],
    );
    const layout = layoutTopology(graph);

    expect(layout.routes["routes:a->b"].at(0)?.x).toBeLessThan(layout.routes["routes:a->b"].at(-1)?.x ?? 0);
    expect(layout.routes["calls:b->a"].length).toBeGreaterThanOrEqual(2);
  });

  it("lays out many random graphs without throwing", () => {
    let seed = 1;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;

      return seed / 4294967296;
    };
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
    const kinds = ["Service", "Gateway", "VirtualService", "APISIX route", "Deployment", "Pod", "Ingress"];

    for (let round = 0; round < 400; round++) {
      const nodes: TopologyNode[] = [];

      if (random() < 0.8) {
        nodes.push({ ...card("outside", "External", ""), namespace: "" });
      }

      for (let i = 0, count = 3 + Math.floor(random() * 10); i < count; i++) {
        const outsideView = random() < 0.5;
        const namespace = outsideView ? pick(["a", "b"]) : "main";

        nodes.push({
          ...card(`n${i}`, pick(kinds), outsideView ? `ns:${namespace}` : `main/${pick(["x", "y"])}`, outsideView),
          namespace,
        });
      }

      const edges = new Map<string, TopologyEdge>();

      for (let i = 0, count = 2 + Math.floor(random() * 14); i < count; i++) {
        const from = pick(nodes).id;
        const to = pick(nodes).id;

        if (from !== to) {
          const edge = link(from, to, pick(["routes", "routes", "calls", "exposes"] as const));

          edges.set(edge.id, edge);
        }
      }

      expectDrawable(graphOf(nodes, [...edges.values()]));
    }
  });

  it("compactSizeOf returns compact dimensions for nodes", () => {
    const deploymentNode: TopologyNode = {
      ...card("app-dep", "Deployment", "app"),
      namespace: "default",
    };
    const ingressNode: TopologyNode = {
      ...card("app-ing", "Ingress", "app"),
      namespace: "default",
    };
    const serviceNode: TopologyNode = {
      ...card("app-svc", "Service", "app"),
      namespace: "default",
    };

    expect(compactSizeOf(deploymentNode)).toEqual([140, 42]);
    expect(compactSizeOf(ingressNode)).toEqual([130, 34]);
    expect(compactSizeOf(serviceNode)).toEqual([130, 34]);
  });

  it("layoutTopology lays out graph with compactSizeOf", () => {
    const dep = { ...card("d1", "Deployment", "d1"), namespace: "default" };
    const svc = { ...card("s1", "Service", "s1"), namespace: "default" };
    const e = link("s1", "d1", "routes");

    const layout = layoutTopology(graphOf([dep, svc], [e]), { size: compactSizeOf });
    expect(layout.nodes.length).toBe(2);
    const d1 = layout.nodes.find((n) => n.id === "d1");
    const s1 = layout.nodes.find((n) => n.id === "s1");
    expect(d1?.width).toBe(140);
    expect(d1?.height).toBe(42);
    expect(s1?.width).toBe(130);
    expect(s1?.height).toBe(34);
  });
});
