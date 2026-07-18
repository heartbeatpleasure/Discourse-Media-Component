// javascripts/discourse/routes/media-library.js
import DiscourseRoute from "discourse/routes/discourse";
import I18n from "I18n";

export default class MediaLibraryRoute extends DiscourseRoute {
  titleToken() {
    return I18n.t("media_gallery.title");
  }
}
