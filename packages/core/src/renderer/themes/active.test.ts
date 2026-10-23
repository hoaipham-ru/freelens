/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { computed, observable } from "mobx";
import { describe, expect, it } from "vitest";
import lensColorThemePreferenceInjectable from "../../features/user-preferences/common/lens-color-theme.injectable";
import { getDiForUnitTesting } from "../getDiForUnitTesting";
import activeThemeInjectable from "./active.injectable";
import systemThemeConfigurationInjectable from "./system-theme.injectable";

describe("active theme", () => {
  it.each([
    ["dark", "Dark"],
    ["light", "Light"],
  ] as const)("follows a %s system with the classic theme, not a v2 one", (type, name) => {
    const di = getDiForUnitTesting();

    di.override(lensColorThemePreferenceInjectable, () => computed(() => ({ useSystemTheme: true as const })));
    di.override(systemThemeConfigurationInjectable, () => observable.box<"dark" | "light">(type));

    const theme = di.inject(activeThemeInjectable).get();

    expect(theme).toMatchObject({ type, name });
    expect(theme.uiV2).toBeUndefined();
  });
});
