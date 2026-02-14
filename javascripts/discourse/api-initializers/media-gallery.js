// javascripts/discourse/api-initializers/media-gallery.js
import { apiInitializer } from "discourse/lib/api";
import I18n from "I18n";

export default apiInitializer("1.0", (api) => {
  // Ensure required icons are available (Discourse only ships a whitelist by default)
  ["xmark", "calendar-alt", "heart", "far-heart"].forEach((icon) => api.includeIcon(icon));

  const themeSettings = api.container.lookup("service:theme-settings");
  const showNav = themeSettings?.getSetting?.("show_nav_item");

  if (!showNav) return;

  const customText = themeSettings?.getSetting?.("nav_item_text") || "";
  const label = customText.trim().length ? customText.trim() : I18n.t("media_gallery.title");

  api.addNavigationBarItem({
    name: "media-library",
    displayName: label,
    href: "/media-library",
    title: label,
  });
});
