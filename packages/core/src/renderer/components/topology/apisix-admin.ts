/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Reading APISIX routes from its Admin API, for Topology and the Service map. APISIX keeps
// its routes in etcd, not in Kubernetes, so nothing announces a change: callers read again
// every minute.

import { findApisixAdmins, findApisixViewerKey, parseApisixRoutes } from "./topology-model";

import type { KubeJsonApi } from "@freelensapp/kube-api";

import type { ApisixInstance, RawObject } from "./topology-model";

export interface ApisixStatus {
  routes?: number;
  error?: string;
  /** Where the key came from */
  source?: "configmap" | "entered";
}

export interface ApisixKey {
  key: string;
  source: "configmap" | "entered";
}

/**
 * The key for each APISIX Admin API, by `namespace/service`: one entered by the user, else the
 * viewer key found in its ConfigMap, read with the user's own access. Never an admin key.
 */
export function apisixKeysOf(
  services: RawObject[],
  configMaps: RawObject[],
  entered: Record<string, string>,
): Record<string, ApisixKey> {
  const keys: Record<string, ApisixKey> = {};

  for (const admin of findApisixAdmins(services)) {
    const id = `${admin.namespace}/${admin.name}`;

    if (entered[id]) {
      keys[id] = { key: entered[id], source: "entered" };
      continue;
    }

    const found = findApisixViewerKey(configMaps, admin.namespace);

    if (found) {
      keys[id] = { key: found, source: "configmap" };
    }
  }

  return keys;
}

/**
 * Reads the routes of every APISIX instance that has a key, through the Kubernetes API's
 * service proxy. getResponse writes no log, so the key never lands in the console.
 */
export async function readApisix(
  apiKube: KubeJsonApi,
  services: RawObject[],
  keys: Record<string, ApisixKey>,
): Promise<{ instances: ApisixInstance[]; status: Record<string, ApisixStatus> }> {
  const instances: ApisixInstance[] = [];
  const status: Record<string, ApisixStatus> = {};

  await Promise.all(
    findApisixAdmins(services).map(async (admin) => {
      const id = `${admin.namespace}/${admin.name}`;
      const { key, source } = keys[id] ?? {};

      if (!key) {
        status[id] = {};

        return;
      }

      const get = async (what: string) => {
        const response = await apiKube.getResponse(
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
        const [routes, upstreams, servicesResponse] = await Promise.all([
          get("routes"),
          get("upstreams").catch(() => undefined),
          get("services").catch(() => undefined),
        ]);
        const parsed = parseApisixRoutes(routes, upstreams, servicesResponse);

        instances.push({ namespace: admin.namespace, adminService: admin.name, routes: parsed });
        status[id] = { routes: parsed.length, source };
      } catch (error) {
        status[id] = { error: error instanceof Error ? error.message : String(error), source };
      }
    }),
  );

  return { instances, status };
}
