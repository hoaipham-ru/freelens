/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { getInjectable } from "@ogre-tools/injectable";
import serviceMapRouteInjectable from "../../../common/front-end-routing/routes/cluster/service-map/service-map-route.injectable";
import { routeSpecificComponentInjectionToken } from "../../routes/route-specific-component-injection-token";
import { ServiceMap } from "./service-map";

const serviceMapRouteComponentInjectable = getInjectable({
  id: "service-map-route-component",

  instantiate: (di) => ({
    route: di.inject(serviceMapRouteInjectable),
    Component: ServiceMap,
  }),

  injectionToken: routeSpecificComponentInjectionToken,
});

export default serviceMapRouteComponentInjectable;
