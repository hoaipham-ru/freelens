/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { getInjectable } from "@ogre-tools/injectable";
import { navigateToRouteInjectionToken } from "../../../navigate-to-route-injection-token";
import topologyRouteInjectable from "./topology-route.injectable";

const navigateToTopologyInjectable = getInjectable({
  id: "navigate-to-topology",

  instantiate: (di) => {
    const navigateToRoute = di.inject(navigateToRouteInjectionToken);
    const route = di.inject(topologyRouteInjectable);

    return () => navigateToRoute(route);
  },
});

export default navigateToTopologyInjectable;
