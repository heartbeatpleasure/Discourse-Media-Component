import Controller from "@ember/controller";
import { tracked } from "@glimmer/tracking";

// Register the Media Library uploader query param with Ember's router.
// Otherwise internal Discourse navigation can discard ?uploader=username.
export default class MediaLibraryController extends Controller {
  queryParams = ["uploader"];
  @tracked uploader = "";
}
