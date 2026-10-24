/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { ago, analysePod, buildHealthReport, podBoxes, registryOf } from "./service-map-model";

import type { RawObject } from "../topology/topology-model";
import type { HealthInput, RawEvent } from "./service-map-model";

const NOW = Date.parse("2026-10-24T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const empty = (): HealthInput => ({
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
  events: [],
  nodes: [],
  storageClasses: [],
  ingressClasses: [],
  secretNames: new Set(),
  now: NOW,
});

const deployment = (namespace: string, name: string, extra: { replicas?: number; ready?: number; spec?: any } = {}) =>
  ({
    kind: "Deployment",
    metadata: { name, namespace, uid: `uid-${namespace}-${name}` },
    spec: {
      replicas: extra.replicas ?? 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: extra.spec ?? { containers: [{ name, image: `${name}:1` }] },
      },
    },
    status: { readyReplicas: extra.ready ?? extra.replicas ?? 1 },
  }) as RawObject;

const statefulSet = (namespace: string, name: string, extra: { replicas?: number; ready?: number } = {}) =>
  ({
    kind: "StatefulSet",
    metadata: { name, namespace, uid: `uid-${namespace}-${name}` },
    spec: {
      replicas: extra.replicas ?? 1,
      selector: { matchLabels: { app: name } },
      template: { metadata: { labels: { app: name } }, spec: { containers: [{ name, image: `${name}:1` }] } },
    },
    status: { readyReplicas: extra.ready ?? extra.replicas ?? 1 },
  }) as RawObject;

const replicaSet = (owner: RawObject) =>
  ({
    kind: "ReplicaSet",
    metadata: {
      name: `${owner.metadata.name}-rs`,
      namespace: owner.metadata.namespace,
      uid: `uid-rs-${owner.metadata.name}`,
      ownerReferences: [{ kind: owner.kind as string, name: owner.metadata.name, uid: owner.metadata.uid }],
    },
  }) as RawObject;

type PodState = "running" | "not-ready" | "crash" | "image" | "pending" | "init";

const pod = (owner: RawObject, index: number, state: PodState, extra: { image?: string; node?: string } = {}) => {
  const rsOwned = owner.kind === "Deployment";
  const name = `${owner.metadata.name}-${rsOwned ? "rs-" : ""}${index}`;
  const container = owner.metadata.name;
  const ready = state === "running";
  const waiting =
    state === "crash"
      ? { reason: "CrashLoopBackOff", message: "back-off 5m0s restarting failed container" }
      : state === "image"
        ? { reason: "ImagePullBackOff", message: `Back-off pulling image "${extra.image}"` }
        : undefined;

  return {
    kind: "Pod",
    metadata: {
      name,
      namespace: owner.metadata.namespace,
      labels: { app: owner.metadata.name },
      creationTimestamp: minutesAgo(600),
      ownerReferences: rsOwned
        ? [{ kind: "ReplicaSet", name: `${owner.metadata.name}-rs`, uid: `uid-rs-${owner.metadata.name}` }]
        : [{ kind: owner.kind as string, name: owner.metadata.name, uid: owner.metadata.uid }],
    },
    spec: {
      nodeName: state === "pending" ? undefined : (extra.node ?? "worker-1"),
      containers: [{ name: container, image: extra.image ?? `${container}:1` }],
      initContainers: state === "init" ? [{ name: "vault-agent-init", image: "vault:1" }] : undefined,
    },
    status: {
      phase: state === "pending" || state === "init" ? "Pending" : "Running",
      conditions: [
        state === "pending"
          ? {
              type: "PodScheduled",
              status: "False",
              reason: "Unschedulable",
              message: "0/3 nodes are available: 3 Insufficient memory.",
              lastTransitionTime: minutesAgo(90),
            }
          : { type: "PodScheduled", status: "True" },
        { type: "Initialized", status: state === "init" ? "False" : "True", lastTransitionTime: minutesAgo(120) },
        { type: "Ready", status: ready ? "True" : "False", lastTransitionTime: minutesAgo(120) },
      ],
      initContainerStatuses:
        state === "init"
          ? [
              {
                name: "vault-agent-init",
                ready: false,
                restartCount: 0,
                state: { running: { startedAt: minutesAgo(120) } },
              },
            ]
          : undefined,
      containerStatuses:
        state === "pending"
          ? undefined
          : [
              {
                name: container,
                image: extra.image ?? `${container}:1`,
                ready,
                restartCount: state === "crash" ? 7 : 0,
                state: waiting
                  ? { waiting }
                  : state === "init"
                    ? { waiting: { reason: "PodInitializing" } }
                    : { running: { startedAt: minutesAgo(300) } },
                lastState:
                  state === "crash"
                    ? { terminated: { reason: "Error", exitCode: 1, finishedAt: minutesAgo(3) } }
                    : undefined,
              },
            ],
    },
  } as RawObject;
};

const service = (namespace: string, name: string, extra: { selector?: Record<string, string>; type?: string } = {}) =>
  ({
    kind: "Service",
    metadata: { name, namespace, creationTimestamp: minutesAgo(10_000) },
    spec: {
      type: extra.type ?? "ClusterIP",
      selector: extra.selector ?? { app: name },
      ports: [{ port: 80 }],
    },
    status: {},
  }) as RawObject;

const warning = (
  kind: string,
  namespace: string,
  name: string,
  reason: string,
  message: string,
  count = 1,
): RawEvent => ({
  metadata: { name: `${name}.${reason}`, namespace, creationTimestamp: minutesAgo(60) },
  involvedObject: { kind, namespace, name },
  type: "Warning",
  reason,
  message,
  count,
  firstTimestamp: minutesAgo(60),
  lastTimestamp: minutesAgo(1),
});

describe("service map model", () => {
  describe("pods", () => {
    it("reads a crash loop with its last exit", () => {
      const owner = deployment("a", "api");
      const { info, findings } = analysePod(pod(owner, 0, "crash"), "deployment/a/api", NOW);

      expect(info.health).toBe("err");
      expect(info.status).toBe("CrashLoopBackOff");
      expect(info.restarts).toBe(7);
      expect(findings.map((f) => f.rule)).toEqual(["crashloop"]);
      expect(findings[0].detail).toContain("exit code 1");
      expect(findings[0].previous).toBe(true);
    });

    it("tells a pod that can't be scheduled", () => {
      const { findings, info } = analysePod(pod(deployment("a", "api"), 0, "pending"), "x", NOW);

      expect(findings[0]).toMatchObject({ rule: "unschedulable", severity: "critical" });
      expect(findings[0].detail).toContain("Insufficient memory");
      expect(info.status).toBe("Pending");
    });

    it("tells an init container that never finishes", () => {
      const { findings, info } = analysePod(pod(deployment("a", "api"), 0, "init"), "x", NOW);

      expect(findings[0]).toMatchObject({ rule: "stuck-init", container: "vault-agent-init" });
      expect(info.status).toBe("Init:0/1");
    });

    it("takes the registry of an image", () => {
      expect(registryOf("nginx:1.27")).toBe("docker.io");
      expect(registryOf("bitnami/redis:7")).toBe("docker.io");
      expect(registryOf("docker-nexus.paraline.io/pvi-connect/frontend:latest")).toBe("docker-nexus.paraline.io");
      expect(registryOf("localhost:5000/app")).toBe("localhost:5000");
    });

    it("says how long ago, shortly", () => {
      expect(ago(13 * 60_000)).toBe("13m");
      expect(ago(39 * 3_600_000)).toBe("39h");
      expect(ago(17 * 86_400_000)).toBe("17d");
    });
  });

  describe("incidents", () => {
    it("finds the root at the end of the chain, and the callers named in events", () => {
      const input = empty();
      const vault = statefulSet("vault", "vault", { replicas: 1, ready: 0 });
      const auth = deployment("platform", "auth", { replicas: 2, ready: 0 });
      const billing = deployment("platform", "billing", { replicas: 1, ready: 1 });

      input.statefulSets = [vault];
      input.deployments = [auth, billing];
      input.replicaSets = [replicaSet(auth), replicaSet(billing)];
      input.pods = [pod(vault, 0, "not-ready"), pod(auth, 0, "init"), pod(auth, 1, "init"), pod(billing, 0, "running")];
      input.services = [
        service("vault", "vault"),
        // selects by a label only the pods carry, not the StatefulSet's template
        service("vault", "vault-standby", { selector: { app: "vault", "vault-active": "false" } }),
        service("platform", "auth"),
        service("platform", "billing"),
      ];
      (input.pods[0].metadata.labels as Record<string, string>)["vault-active"] = "false";
      // billing calls auth: healthy, but at risk
      billing.spec.template.spec.containers[0].env = [{ name: "AUTH_URL", value: "http://auth.platform.svc:80" }];
      input.events = [
        warning(
          "Pod",
          "platform",
          "auth-rs-0",
          "Failed",
          'Failed to get Vault auth login: Put "http://vault.vault.svc.cluster.local:8200/v1/auth/kubernetes/login"',
          86,
        ),
        warning(
          "Pod",
          "vault",
          "vault-0",
          "Unhealthy",
          "Readiness probe failed: HTTP probe failed with statuscode: 503",
          40,
        ),
      ];

      const report = buildHealthReport(input);
      const incident = report.incidents[0];

      expect(report.incidents).toHaveLength(1);
      expect(incident.rootId).toBe("statefulset/vault/vault");
      expect(incident.severity).toBe("critical");
      expect(incident.title).toBe("vault is unavailable");
      expect(incident.cause).toContain("Readiness probe failed");
      expect(incident.nodeIds).toEqual(
        expect.arrayContaining([
          "deployment/platform/auth",
          "service/vault/vault",
          "service/vault/vault-standby",
          "statefulset/vault/vault",
        ]),
      );
      expect(incident.atRiskIds).toEqual(expect.arrayContaining(["deployment/platform/billing"]));
      expect(incident.facts.map((f) => f.text)).toEqual(
        expect.arrayContaining([
          "1 workload names Service vault/vault in Warning events",
          "2 Services select the pods of StatefulSet vault/vault (selector)",
        ]),
      );
      expect(incident.primary).toMatchObject({ pod: "vault-0" });
      expect(incident.cmd).toBe("kubectl -n vault logs vault-0 -c vault --tail=100");
      expect(incident.timeline.rows.map((r) => r.label)).toEqual(["Failed ×86 · auth", "Unhealthy ×40 · vault"]);
    });

    it("blames a private registry that several workloads fail to pull from", () => {
      const input = empty();
      const image = (n: string) => `docker-nexus.paraline.io/pvi-connect/${n}:latest`;
      const frontend = deployment("pvi", "frontend", {
        ready: 0,
        spec: { containers: [{ name: "frontend", image: image("frontend") }] },
      });
      const backend = deployment("pvi", "backend", {
        ready: 0,
        spec: { containers: [{ name: "backend", image: image("backend") }] },
      });

      input.deployments = [frontend, backend];
      input.replicaSets = [replicaSet(frontend), replicaSet(backend)];
      input.pods = [
        pod(frontend, 0, "image", { image: image("frontend") }),
        pod(backend, 0, "image", { image: image("backend") }),
      ];
      input.services = [service("pvi", "frontend"), service("pvi", "backend")];

      const report = buildHealthReport(input);

      expect(report.incidents).toHaveLength(1);
      expect(report.incidents[0].rootId).toBe("registry//docker-nexus.paraline.io");
      expect(report.incidents[0].title).toBe("Images from docker-nexus.paraline.io can't be pulled");
      expect(report.incidents[0].nodeIds).toHaveLength(5);
    });

    it("keeps failures from a public registry apart", () => {
      const input = empty();
      const a = deployment("x", "a", { ready: 0, spec: { containers: [{ name: "a", image: "nginx:nope" }] } });
      const b = deployment("y", "b", { ready: 0, spec: { containers: [{ name: "b", image: "redis:nope" }] } });

      input.deployments = [a, b];
      input.replicaSets = [replicaSet(a), replicaSet(b)];
      input.pods = [pod(a, 0, "image", { image: "nginx:nope" }), pod(b, 0, "image", { image: "redis:nope" })];

      const report = buildHealthReport(input);

      expect(report.incidents.map((i) => i.title).sort()).toEqual(["a can't pull its image", "b can't pull its image"]);
    });

    it("blames a missing pull secret before the registry", () => {
      const input = empty();
      const image = "harbor.example.com/hanas/vault:1";
      const hv = deployment("hanas", "hanas-vault", {
        ready: 0,
        spec: { imagePullSecrets: [{ name: "harbor-secret" }], containers: [{ name: "hanas-vault", image }] },
      });

      input.deployments = [hv];
      input.replicaSets = [replicaSet(hv)];
      input.pods = [pod(hv, 0, "image", { image })];

      const incident = buildHealthReport(input).incidents[0];

      expect(incident.rootId).toBe("secret/hanas/harbor-secret");
      expect(incident.title).toBe("Secret harbor-secret doesn't exist");
      expect(incident.cmd).toContain("create secret docker-registry harbor-secret");
    });

    it("doesn't blame a missing Service only named in configuration", () => {
      const input = empty();
      const app = deployment("a", "app", {
        ready: 0,
        spec: {
          containers: [{ name: "app", image: "app:1", env: [{ name: "X", value: "http://gone.other.svc:80" }] }],
        },
      });

      input.deployments = [app];
      input.replicaSets = [replicaSet(app)];
      input.pods = [pod(app, 0, "crash")];

      const report = buildHealthReport(input);

      expect(report.incidents[0].rootId).toBe("deployment/a/app");
      expect(report.incidents[0].title).toBe("app keeps crashing");
      expect(report.incidents[0].isolated).toBe(true);
      expect(report.housekeeping.map((h) => h.rule)).toContain("missing-service-ref");
    });

    it("groups LoadBalancer Services without an address, wherever they are", () => {
      const input = empty();

      input.services = [
        service("istio-system", "istio-ingressgateway", { type: "LoadBalancer", selector: {} }),
        service("dremio", "dremio", { type: "LoadBalancer", selector: {} }),
      ];

      const report = buildHealthReport(input);

      expect(report.incidents).toHaveLength(1);
      expect(report.incidents[0]).toMatchObject({
        rootId: "lbprovider//",
        severity: "warning",
        title: "No LoadBalancer controller: 2 Services wait for an address",
      });
    });

    it("tells a CronJob whose last runs failed", () => {
      const input = empty();
      const cronJob = {
        kind: "CronJob",
        metadata: { name: "compaction", namespace: "flink", uid: "cj" },
        spec: { schedule: "*/15 * * * *", jobTemplate: { spec: { template: { spec: { containers: [] } } } } },
      } as RawObject;
      const run = (n: number, failed: boolean) =>
        ({
          kind: "Job",
          metadata: {
            name: `compaction-${n}`,
            namespace: "flink",
            uid: `job-${n}`,
            ownerReferences: [{ kind: "CronJob", name: "compaction", uid: "cj" }],
          },
          status: {
            startTime: minutesAgo(100 - n),
            conditions: [
              failed
                ? {
                    type: "Failed",
                    status: "True",
                    reason: "BackoffLimitExceeded",
                    lastTransitionTime: minutesAgo(99 - n),
                  }
                : { type: "Complete", status: "True" },
            ],
          },
        }) as RawObject;

      input.cronJobs = [cronJob];
      input.jobs = [run(1, false), run(2, true), run(3, true), run(4, true)];

      const incident = buildHealthReport(input).incidents[0];

      expect(incident.title).toBe("compaction keeps failing");
      expect(incident.cause).toContain("Its last 3 runs failed (BackoffLimitExceeded); the newest is compaction-4.");
      expect(incident.cmd).toBe("kubectl -n flink logs job/compaction-4");
    });

    it("puts what isn't urgent in housekeeping", () => {
      const input = empty();
      const idle = deployment("a", "idle", { replicas: 0 });

      input.deployments = [idle];
      input.services = [service("a", "idle"), service("a", "orphan", { selector: { app: "nothing" } })];

      const report = buildHealthReport(input);

      expect(report.incidents).toEqual([]);
      expect(report.housekeeping.map((h) => [h.rule, h.count])).toEqual([
        ["scaled-to-zero", 1],
        ["service-no-pods", 1],
      ]);
    });

    it("makes a Service that selects nothing urgent once something sends to it", () => {
      const input = empty();
      const caller = deployment("a", "caller", {
        spec: { containers: [{ name: "c", image: "c:1", env: [{ name: "U", value: "http://orphan.a.svc:80" }] }] },
      });

      input.deployments = [caller];
      input.replicaSets = [replicaSet(caller)];
      input.pods = [pod(caller, 0, "running")];
      input.services = [service("a", "orphan", { selector: { app: "nothing" } }), service("a", "caller")];

      const report = buildHealthReport(input);

      expect(report.incidents).toHaveLength(1);
      expect(report.incidents[0]).toMatchObject({ rootId: "service/a/orphan", severity: "warning" });
      expect(report.incidents[0].atRiskIds).toContain("deployment/a/caller");
    });

    it("skips the check for missing Secrets when Secrets can't be listed", () => {
      const input = empty();
      const app = deployment("a", "app", {
        spec: { containers: [{ name: "app", image: "app:1", envFrom: [{ secretRef: { name: "creds" } }] }] },
      });

      input.deployments = [app];
      input.replicaSets = [replicaSet(app)];
      input.pods = [pod(app, 0, "running")];
      input.secretNames = undefined;

      expect(buildHealthReport(input).incidents).toEqual([]);

      input.secretNames = new Set();

      const report = buildHealthReport(input);

      expect(report.incidents[0]).toMatchObject({ rootId: "secret/a/creds", severity: "warning" });
    });
  });

  describe("pods view", () => {
    it("draws workloads with their pods, linked through the Services between them", () => {
      const input = empty();
      const db = statefulSet("data", "db", { replicas: 1, ready: 0 });
      const api = deployment("a", "api", {
        ready: 0,
        spec: { containers: [{ name: "api", image: "api:1", env: [{ name: "DB", value: "db.data.svc:5432" }] }] },
      });

      input.statefulSets = [db];
      input.deployments = [api];
      input.replicaSets = [replicaSet(api)];
      input.pods = [pod(db, 0, "crash", { node: "worker-2" }), pod(api, 0, "not-ready")];
      input.services = [service("data", "db"), service("a", "api")];

      const report = buildHealthReport(input);
      const incident = report.incidents[0];
      const byWorkload = podBoxes(report, incident, "workload");
      const byNode = podBoxes(report, incident, "node");

      expect(incident.rootId).toBe("statefulset/data/db");
      expect(byWorkload.boxes.map((b) => [b.id, b.pods.length, b.root])).toEqual(
        expect.arrayContaining([
          ["statefulset/data/db", 1, true],
          ["deployment/a/api", 1, false],
        ]),
      );
      expect(byWorkload.links).toEqual([{ from: "deployment/a/api", to: "statefulset/data/db", tone: "err" }]);
      expect(byNode.boxes.map((b) => b.title)).toEqual(["worker-1", "worker-2"]);
    });
  });
});
