// javascripts/discourse/routes/media-library.js
import DiscourseRoute from "discourse/routes/discourse";

export default class MediaLibraryRoute extends DiscourseRoute {
  titleToken() {
    return "media_gallery.title";
  }
}
