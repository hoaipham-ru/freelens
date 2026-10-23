/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { getInjectable } from "@ogre-tools/injectable";
import createStorageInjectable from "../../utils/create-storage/create-storage.injectable";

/**
 * Keys for the Admin API of APISIX instances, by `namespace/service`. Kept with the local storage
 * of the cluster of this frame, so a key only ever goes to the cluster it was entered for.
 */
const topologyApisixKeysStorageInjectable = getInjectable({
  id: "topology-apisix-keys-storage",
  instantiate: (di) => di.inject(createStorageInjectable)<Record<string, string>>("topology_apisix_keys", {}),
});

export default topologyApisixKeysStorageInjectable;
