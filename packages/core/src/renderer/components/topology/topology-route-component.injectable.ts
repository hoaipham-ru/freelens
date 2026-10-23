/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { getInjectable } from "@ogre-tools/injectable";
import topologyRouteInjectable from "../../../common/front-end-routing/routes/cluster/topology/topology-route.injectable";
import { routeSpecificComponentInjectionToken } from "../../routes/route-specific-component-injection-token";
import { Topology } from "./topology";

const topologyRouteComponentInjectable = getInjectable({
  id: "topology-route-component",

  instantiate: (di) => ({
    route: di.inject(topologyRouteInjectable),
    Component: Topology,
  }),

  injectionToken: routeSpecificComponentInjectionToken,
});

export default topologyRouteComponentInjectable;
