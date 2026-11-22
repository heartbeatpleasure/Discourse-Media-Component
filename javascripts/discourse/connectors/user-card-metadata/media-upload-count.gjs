import MediaUserUploadCount from "../../components/media-user-upload-count";

// Share the existing Discourse metadata outlet with Solutions and other stats.
// Do not modify the user card or any third-party theme components.
export default <template>
  <MediaUserUploadCount @username={{@outletArgs.user.username}} @placement="card" />
</template>;
