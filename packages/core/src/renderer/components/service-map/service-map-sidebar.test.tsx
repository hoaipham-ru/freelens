/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { getApplicationBuilder } from "../test-utils/get-application-builder";

import type { RenderResult } from "@testing-library/react";

import type { ApplicationBuilder } from "../test-utils/get-application-builder";

describe("service map in the sidebar", () => {
  let builder: ApplicationBuilder;
  let rendered: RenderResult;
  const sidebarIds = () =>
    [...rendered.container.querySelectorAll('[data-testid^="sidebar-item-"]')].map((e) =>
      e.getAttribute("data-testid"),
    );

  beforeEach(() => {
    builder = getApplicationBuilder();
    builder.setEnvironmentToClusterFrame();
  });

  it("is hidden while pods may not be listed", async () => {
    rendered = await builder.render();

    expect(sidebarIds()).not.toContain("sidebar-item-service-map");
  });

  it("shows right after Topology when pods may be listed", async () => {
    builder.afterWindowStart(() => {
      builder.allowKubeResource({ apiName: "pods", group: "" });
    });
    rendered = await builder.render();

    const ids = sidebarIds();

    expect(ids).toContain("sidebar-item-service-map");
    expect(ids.indexOf("sidebar-item-service-map")).toBe(ids.indexOf("sidebar-item-topology") + 1);
  });
});
