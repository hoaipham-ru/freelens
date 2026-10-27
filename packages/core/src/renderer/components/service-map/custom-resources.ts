/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// What the Service Map knows of custom resources: the operators that keep a cluster running
// (Strimzi Kafka, Vault Secrets Operator, Flux, Argo CD) say whether they are well in
// `status.conditions` (or, for Argo CD, `status.health`), and label, own or list what they make.
// Pure, like the rest of the model: it reads objects and returns verdicts and links.

import { keyOf, podTemplateOf } from "../topology/topology-model";

import type { RawObject } from "../topology/topology-model";

export const CUSTOM_RESOURCE_GROUPS = [
  "kafka.strimzi.io",
  "secrets.hashicorp.com",
  "helm.toolkit.fluxcd.io",
  "kustomize.toolkit.fluxcd.io",
  "source.toolkit.fluxcd.io",
  "argoproj.io",
] as const;

// Argo CD's group also holds Rollouts and Workflows, which are about something else.
const ARGO_KINDS = ["Application", "ApplicationSet"];

/** Whether the Service Map reads the resources of a CRD: its group is one it knows, and so is its kind. */
export function isWatchedCustomResource(group: string, kind: string): boolean {
  if (group === "argoproj.io") {
    return ARGO_KINDS.includes(kind);
  }

  return (CUSTOM_RESOURCE_GROUPS as readonly string[]).includes(group);
}

type Severity = "critical" | "warning" | "info";

export interface CustomResourceVerdict {
  /** Something to tell: it is not well, or (info) not what was declared */
  issue: boolean;
  severity: Severity;
  /** A few words, e.g. "ReconciliationFailed" */
  title: string;
  detail: string;
  /** What the controller said */
  message?: string;
  since?: number;
  /** For the card: what it is, when nothing is wrong */
  sub: string;
}

interface Condition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

// False means trouble for these...
const WELL_TYPES = ["Ready", "Healthy", "Available", "Reconciled", "ResourcesUpToDate"];
// ...and True means trouble for these.
const TROUBLE_TYPES = ["Stalled", "NotReady", "Failed", "Degraded", "ErrorOccurred"];

const time = (text?: string) => {
  const parsed = text ? Date.parse(text) : Number.NaN;

  return Number.isNaN(parsed) ? undefined : parsed;
};

const short = (text: string | undefined, max = 220) =>
  text && text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** Reads the status of a custom resource of a group the Service Map knows. */
export function analyseCustomResource(cr: RawObject): CustomResourceVerdict {
  const kind = cr.kind ?? "";
  const name = cr.metadata.name;
  const conditions: Condition[] = Array.isArray(cr.status?.conditions) ? cr.status.conditions : [];
  const group = (cr.apiVersion ?? "").split("/")[0];
  const well: CustomResourceVerdict = {
    issue: false,
    severity: "info",
    title: "",
    detail: "",
    sub:
      conditions.find((c) => c.type && WELL_TYPES.includes(c.type) && c.status === "True")?.type ??
      "no problem reported",
  };

  if (cr.spec?.suspend === true) {
    return { ...well, sub: "suspended" };
  }

  if (group === "argoproj.io" && kind === "Application") {
    const health: string | undefined = cr.status?.health?.status;
    const sync: string | undefined = cr.status?.sync?.status;
    const operation = cr.status?.operationState as
      | { phase?: string; message?: string; finishedAt?: string }
      | undefined;
    const errorCondition = conditions.find((c) => c.type?.endsWith("Error") && c.status !== "False");
    const sub = [sync, health].filter(Boolean).join(" · ") || well.sub;

    if (health === "Degraded" || health === "Missing") {
      return {
        issue: true,
        severity: "warning",
        title: health,
        detail: `Argo CD reports ${name} as ${health}${sync ? ` and ${sync}` : ""}: something it deployed is not well.`,
        message: short(errorCondition?.message ?? operation?.message),
        since: time(errorCondition?.lastTransitionTime ?? operation?.finishedAt),
        sub,
      };
    }

    if (errorCondition || operation?.phase === "Error" || operation?.phase === "Failed") {
      return {
        issue: true,
        severity: "warning",
        title: errorCondition?.type ?? `sync ${operation?.phase?.toLowerCase()}`,
        detail: `Argo CD could not ${errorCondition?.type === "ComparisonError" ? "compare" : "sync"} ${name} with its source.`,
        message: short(errorCondition?.message ?? operation?.message),
        since: time(errorCondition?.lastTransitionTime ?? operation?.finishedAt),
        sub,
      };
    }

    if (sync === "OutOfSync") {
      return {
        issue: true,
        severity: "info",
        title: "OutOfSync",
        detail: `${name} differs from what its source declares.`,
        sub,
      };
    }

    return { ...well, sub };
  }

  const trouble =
    conditions.find((c) => c.type && TROUBLE_TYPES.includes(c.type) && c.status === "True") ??
    conditions.find((c) => c.type && WELL_TYPES.includes(c.type) && c.status === "False");

  if (!trouble) {
    return well;
  }

  const stateText = TROUBLE_TYPES.includes(trouble.type ?? "") ? (trouble.type as string) : `not ${trouble.type}`;

  return {
    // The cluster itself is what the rest hangs from.
    severity: kind === "Kafka" ? "critical" : "warning",
    issue: true,
    title: trouble.reason || stateText,
    detail: `${kind} ${name} is ${stateText}${trouble.reason ? ` (${trouble.reason})` : ""}.`,
    message: short(trouble.message),
    since: time(trouble.lastTransitionTime),
    sub: trouble.reason || stateText,
  };
}

export interface CustomResourceLink {
  from: RawObject;
  to: RawObject;
  /** `needs`: depends on it; `deploys`: puts it in the cluster; `managed-by`: is kept by it */
  type: "needs" | "deploys" | "managed-by";
  via: string;
}

const WORKLOAD_KINDS = ["Deployment", "StatefulSet", "DaemonSet"];
const nsOf = (o: RawObject) => o.metadata.namespace ?? "";
const isWorkload = (o: RawObject) => WORKLOAD_KINDS.includes(o.kind ?? "");
const isMadeByAnOperator = (o: RawObject) => isWorkload(o) || o.kind === "Service";

function labelsOf(o: RawObject): Record<string, string> {
  return { ...(o.metadata.labels ?? {}), ...(isWorkload(o) ? podTemplateOf(o).labels : {}) };
}

/** The Secrets a workload reads: volumes, environment, and image pulls. */
export function secretNamesOf(workload: RawObject): Set<string> {
  const spec = podTemplateOf(workload).spec ?? {};
  const names = new Set<string>();
  const containers = [...(spec.containers ?? []), ...(spec.initContainers ?? [])] as {
    env?: { valueFrom?: { secretKeyRef?: { name?: string } } }[];
    envFrom?: { secretRef?: { name?: string } }[];
  }[];

  for (const volume of (spec.volumes ?? []) as { secret?: { secretName?: string } }[]) {
    if (volume.secret?.secretName) names.add(volume.secret.secretName);
  }

  for (const container of containers) {
    for (const env of container.env ?? []) {
      if (env.valueFrom?.secretKeyRef?.name) names.add(env.valueFrom.secretKeyRef.name);
    }

    for (const from of container.envFrom ?? []) {
      if (from.secretRef?.name) names.add(from.secretRef.name);
    }
  }

  for (const pull of (spec.imagePullSecrets ?? []) as { name?: string }[]) {
    if (pull.name) names.add(pull.name);
  }

  return names;
}

/** A reference that may be `name` or `namespace/name`. */
const refOf = (ref: unknown, namespace: string): { namespace: string; name: string } | undefined => {
  if (typeof ref === "string" && ref) {
    const [first, second] = ref.split("/");

    return second ? { namespace: first, name: second } : { namespace, name: first };
  }

  if (ref && typeof ref === "object" && (ref as { name?: string }).name) {
    const { name, namespace: refNamespace } = ref as { name: string; namespace?: string };

    return { namespace: refNamespace || namespace, name };
  }

  return undefined;
};

/**
 * What a custom resource is tied to, among `candidates` (workloads, Services and other custom
 * resources): what it makes, what keeps it, and what it needs.
 */
export function relationsOf(cr: RawObject, candidates: RawObject[]): CustomResourceLink[] {
  const kind = cr.kind ?? "";
  const name = cr.metadata.name;
  const namespace = nsOf(cr);
  const group = (cr.apiVersion ?? "").split("/")[0];
  const found = new Map<string, CustomResourceLink>();
  const idOf = (o: RawObject) => keyOf(o.kind ?? "", nsOf(o), o.metadata.name);
  const add = (link: CustomResourceLink) => {
    const key = `${link.type}:${idOf(link.from)}>${idOf(link.to)}`;

    if (!found.has(key)) found.set(key, link);
  };
  const find = (targetKind: string, targetNamespace: string, targetName: string) =>
    candidates.find(
      (o) => o.kind === targetKind && nsOf(o) === targetNamespace && o.metadata.name === targetName && o !== cr,
    );
  const needs = (target: RawObject | undefined, via: string) =>
    target && add({ from: cr, to: target, type: "needs", via });
  const deploys = (target: RawObject | undefined, via: string) =>
    target && isMadeByAnOperator(target) && add({ from: cr, to: target, type: "deploys", via });

  // Anything an object names as its owner, whatever the operator.
  for (const o of candidates) {
    const owned = (o.metadata.ownerReferences ?? []).some(
      (ref) => ref.kind === kind && ref.name === name && (!ref.uid || !cr.metadata.uid || ref.uid === cr.metadata.uid),
    );

    if (owned && nsOf(o) === namespace && isMadeByAnOperator(o)) {
      add({ from: o, to: cr, type: "managed-by", via: `ownerReference ${kind}` });
    }
  }

  if (group === "kafka.strimzi.io") {
    const cluster = cr.metadata.labels?.["strimzi.io/cluster"];
    const parentKind = { KafkaTopic: "Kafka", KafkaUser: "Kafka", KafkaConnector: "KafkaConnect" }[kind];

    if (parentKind) {
      needs(cluster ? find(parentKind, namespace, cluster) : undefined, "label strimzi.io/cluster");
    } else {
      for (const o of candidates) {
        const labels = labelsOf(o);

        if (
          isMadeByAnOperator(o) &&
          nsOf(o) === namespace &&
          labels["strimzi.io/cluster"] === name &&
          (!labels["strimzi.io/kind"] || labels["strimzi.io/kind"] === kind)
        ) {
          add({ from: o, to: cr, type: "managed-by", via: "label strimzi.io/cluster" });
        }
      }
    }
  }

  if (group === "helm.toolkit.fluxcd.io" || group === "kustomize.toolkit.fluxcd.io") {
    const prefix = group;

    for (const o of candidates) {
      const labels = labelsOf(o);

      if (labels[`${prefix}/name`] === name && labels[`${prefix}/namespace`] === namespace) {
        deploys(o, `label ${prefix}/name`);
      }
    }

    // A Kustomization lists what it applied as `namespace_name_group_Kind`.
    for (const entry of (cr.status?.inventory?.entries ?? []) as { id?: string }[]) {
      const [entryNamespace, entryName, , entryKind] = (entry.id ?? "").split("_");

      if (entryName && entryKind) deploys(find(entryKind, entryNamespace, entryName), "inventory");
    }

    const source = refOf(cr.spec?.sourceRef ?? cr.spec?.chart?.spec?.sourceRef ?? cr.spec?.chartRef, namespace);
    const sourceKind = (cr.spec?.sourceRef ?? cr.spec?.chart?.spec?.sourceRef ?? cr.spec?.chartRef)?.kind as
      | string
      | undefined;

    if (source && sourceKind) needs(find(sourceKind, source.namespace, source.name), "spec.sourceRef");

    for (const dependency of (cr.spec?.dependsOn ?? []) as { name?: string; namespace?: string }[]) {
      const ref = refOf(dependency, namespace);

      if (ref) needs(find(kind, ref.namespace, ref.name), "spec.dependsOn");
    }
  }

  if (group === "argoproj.io" && kind === "Application") {
    for (const resource of (cr.status?.resources ?? []) as { kind?: string; namespace?: string; name?: string }[]) {
      if (resource.kind && resource.name) {
        deploys(find(resource.kind, resource.namespace ?? "", resource.name), "status.resources");
      }
    }

    for (const o of candidates) {
      const tracked =
        o.metadata.labels?.["argocd.argoproj.io/instance"] === name ||
        o.metadata.annotations?.["argocd.argoproj.io/tracking-id"]?.startsWith(`${name}:`);

      if (tracked) deploys(o, "tracked by Argo CD");
    }
  }

  if (group === "secrets.hashicorp.com") {
    const destination = cr.spec?.destination?.name as string | undefined;

    if (destination) {
      for (const o of candidates) {
        if (isWorkload(o) && nsOf(o) === namespace && secretNamesOf(o).has(destination)) {
          add({ from: o, to: cr, type: "managed-by", via: `Secret ${destination}` });
        }
      }
    }

    const auth = refOf(cr.spec?.vaultAuthRef, namespace);
    const connection = refOf(cr.spec?.vaultConnectionRef, namespace);

    if (auth) needs(find("VaultAuth", auth.namespace, auth.name), "spec.vaultAuthRef");
    if (connection) needs(find("VaultConnection", connection.namespace, connection.name), "spec.vaultConnectionRef");
  }

  return [...found.values()];
}
