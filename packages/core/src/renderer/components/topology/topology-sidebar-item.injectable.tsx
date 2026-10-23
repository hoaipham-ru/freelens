/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { sidebarItemInjectionToken } from "@freelensapp/cluster-sidebar";
import { Icon } from "@freelensapp/icon";
import { getInjectable } from "@ogre-tools/injectable";
import navigateToTopologyInjectable from "../../../common/front-end-routing/routes/cluster/topology/navigate-to-topology.injectable";
import topologyRouteInjectable from "../../../common/front-end-routing/routes/cluster/topology/topology-route.injectable";
import { SidebarMenuItem, sidebarMenuItemIds } from "../../../common/sidebar-menu-items-starting-order";
import { getClusterPageMenuOrderInjectable } from "../../../features/user-preferences/common/cluster-page-menu-order.injectable";
import routeIsActiveInjectable from "../../routes/route-is-active.injectable";

const id = SidebarMenuItem.Topology;

const topologySidebarItemInjectable = getInjectable({
  id,

  instantiate: (di) => {
    const route = di.inject(topologyRouteInjectable);
    const getClusterPageMenuOrder = di.inject(getClusterPageMenuOrderInjectable);

    return {
      parentId: null,
      getIcon: () => <Icon material="account_tree" />,
      title: "Topology",
      onClick: di.inject(navigateToTopologyInjectable),
      isActive: di.inject(routeIsActiveInjectable, route),
      isVisible: route.isEnabled,
      orderNumber: getClusterPageMenuOrder(id, sidebarMenuItemIds[id]),
    };
  },

  injectionToken: sidebarItemInjectionToken,
});

export default topologySidebarItemInjectable;
