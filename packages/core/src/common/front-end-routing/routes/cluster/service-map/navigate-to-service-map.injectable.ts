/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { getInjectable } from "@ogre-tools/injectable";
import { navigateToRouteInjectionToken } from "../../../navigate-to-route-injection-token";
import serviceMapRouteInjectable from "./service-map-route.injectable";

const navigateToServiceMapInjectable = getInjectable({
  id: "navigate-to-service-map",

  instantiate: (di) => {
    const navigateToRoute = di.inject(navigateToRouteInjectionToken);
    const route = di.inject(serviceMapRouteInjectable);

    return () => navigateToRoute(route);
  },
});

export default navigateToServiceMapInjectable;
