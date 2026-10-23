/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import assert from "node:assert";
import { getInjectable } from "@ogre-tools/injectable";
import { computed } from "mobx";
import lensColorThemePreferenceInjectable from "../../features/user-preferences/common/lens-color-theme.injectable";
import { lensThemeDeclarationInjectionToken } from "./declaration";
import defaultLensThemeInjectable from "./default-theme.injectable";
import systemThemeConfigurationInjectable from "./system-theme.injectable";
import lensThemesInjectable from "./themes.injectable";

import type { Injectable } from "@ogre-tools/injectable";
import type { IComputedValue } from "mobx";
import type { ReadonlyDeep } from "type-fest";

import type { LensTheme } from "./lens-theme";

// Annotated for declaration emit; see ./declaration.ts.
const activeThemeInjectable: Injectable<IComputedValue<ReadonlyDeep<LensTheme>>> = getInjectable({
  id: "active-theme",
  instantiate: (di) => {
    const lensThemes = di.inject(lensThemesInjectable);
    const themeDecls = di.injectMany(lensThemeDeclarationInjectionToken);
    const lensColorThemePreference = di.inject(lensColorThemePreferenceInjectable);
    const systemThemeConfiguration = di.inject(systemThemeConfigurationInjectable);
    const defaultLensTheme = di.inject(defaultLensThemeInjectable);

    return computed(() => {
      const pref = lensColorThemePreference.get();

      if (pref.useSystemTheme) {
        const systemThemeType = systemThemeConfiguration.get();
        // Several themes share a type now; following the system means the classic one of that
        // type, never one of the v2 themes the user didn't pick.
        const ofType = themeDecls.filter((theme) => theme.type === systemThemeType);
        const matchingTheme = ofType.find((theme) => !theme.uiV2) ?? ofType.at(0);

        assert(matchingTheme, `Missing theme declaration for system theme "${systemThemeType}"`);

        return matchingTheme;
      }

      return lensThemes.get(pref.lensThemeId) ?? defaultLensTheme;
    });
  },
});

export default activeThemeInjectable;
