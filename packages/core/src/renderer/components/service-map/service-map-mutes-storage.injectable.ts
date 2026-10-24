/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { getInjectable } from "@ogre-tools/injectable";
import createStorageInjectable from "../../utils/create-storage/create-storage.injectable";

/** Incidents the user muted, by id, with when: kept with the local storage of this cluster. */
const serviceMapMutesStorageInjectable = getInjectable({
  id: "service-map-mutes-storage",
  instantiate: (di) => di.inject(createStorageInjectable)<Record<string, number>>("service_map_muted", {}),
});

export default serviceMapMutesStorageInjectable;
