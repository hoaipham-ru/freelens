/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import {
  buildTopology,
  findServiceReferences,
  layoutTopology,
  pathOf,
  podStatusOf,
  selectorMatches,
} from "./topology-model";

import type { RawObject, TopologyInput } from "./topology-model";

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

      expect(layout.groups.map((g) => g.id).sort()).toEqual(["dremio", "zookeeper"]);
      expect(group("dremio")!.x).toBeLessThan(group("zookeeper")!.x);

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

    it("adds a Service in another namespace as a node outside the view", () => {
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
        summary: "namespace vault",
      });
      expect(graph.edges).toEqual([
        expect.objectContaining({
          from: "deployment/app/auth-service",
          to: "service/vault/vault",
          type: "calls",
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
});
