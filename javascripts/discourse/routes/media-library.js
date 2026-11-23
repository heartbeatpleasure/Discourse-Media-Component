// javascripts/discourse/routes/media-library.js
import DiscourseRoute from "discourse/routes/discourse";
import I18n from "I18n";

export default class MediaLibraryRoute extends DiscourseRoute {
  // Do not carry a user's upload filter into a later, unfiltered visit.
  resetController(controller, isExiting) {
    if (isExiting) {
      controller.uploader = "";
    }
  }

  titleToken() {
    return I18n.t("media_gallery.title");
  }
}
