/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { sidebarItemInjectionToken } from "@freelensapp/cluster-sidebar";
import { Icon } from "@freelensapp/icon";
import { getInjectable } from "@ogre-tools/injectable";
import navigateToServiceMapInjectable from "../../../common/front-end-routing/routes/cluster/service-map/navigate-to-service-map.injectable";
import serviceMapRouteInjectable from "../../../common/front-end-routing/routes/cluster/service-map/service-map-route.injectable";
import { SidebarMenuItem, sidebarMenuItemIds } from "../../../common/sidebar-menu-items-starting-order";
import { getClusterPageMenuOrderInjectable } from "../../../features/user-preferences/common/cluster-page-menu-order.injectable";
import routeIsActiveInjectable from "../../routes/route-is-active.injectable";

const id = SidebarMenuItem.ServiceMap;

const serviceMapSidebarItemInjectable = getInjectable({
  id,

  instantiate: (di) => {
    const route = di.inject(serviceMapRouteInjectable);
    const getClusterPageMenuOrder = di.inject(getClusterPageMenuOrderInjectable);

    return {
      parentId: null,
      getIcon: () => <Icon material="hub" />,
      title: "Service Map",
      onClick: di.inject(navigateToServiceMapInjectable),
      isActive: di.inject(routeIsActiveInjectable, route),
      isVisible: route.isEnabled,
      orderNumber: getClusterPageMenuOrder(id, sidebarMenuItemIds[id]),
    };
  },

  injectionToken: sidebarItemInjectionToken,
});

export default serviceMapSidebarItemInjectable;
