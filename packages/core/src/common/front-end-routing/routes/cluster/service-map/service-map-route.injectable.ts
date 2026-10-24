/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { getInjectable } from "@ogre-tools/injectable";
import { shouldShowResourceInjectionToken } from "../../../../../features/cluster/showing-kube-resources/common/allowed-resources-injection-token";
import { frontEndRouteInjectionToken } from "../../../front-end-route-injection-token";

const serviceMapRouteInjectable = getInjectable({
  id: "service-map-route",

  instantiate: (di) => ({
    path: "/service-map",
    clusterFrame: true,
    isEnabled: di.inject(shouldShowResourceInjectionToken, {
      apiName: "pods",
      group: "",
    }),
  }),

  injectionToken: frontEndRouteInjectionToken,
});

export default serviceMapRouteInjectable;
