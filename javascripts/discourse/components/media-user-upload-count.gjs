import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { action } from "@ember/object";
import { service } from "@ember/service";
import didInsert from "@ember/render-modifiers/modifiers/did-insert";
import didUpdate from "@ember/render-modifiers/modifiers/did-update";
import willDestroy from "@ember/render-modifiers/modifiers/will-destroy";
import { ajax } from "discourse/lib/ajax";

// Reuse the library's own permission-filtered count. A short-lived cache avoids
// duplicate requests when switching between a user's card and full profile.
const CACHE_DURATION_MS = 60_000;
const MAX_CACHED_USERS = 150;
const counts = new Map();

function countFor(username, viewerId) {
  const key = `${viewerId}:${username.toLowerCase()}`;
  const existing = counts.get(key);
  if (existing && Date.now() - existing.at < CACHE_DURATION_MS) {
    return existing.promise;
  }

  const promise = ajax("/media", {
    type: "GET",
    data: { uploader: username, page: 1, per_page: 1 },
  })
    .then((result) => {
      // Never display a guessed count on an unexpected API response.
      if (!Number.isSafeInteger(result?.total) || result.total < 0) {
        throw new Error("Media Library returned an invalid upload count");
      }
      return result.total;
    })
    .catch((error) => {
      if (counts.get(key)?.promise === promise) {
        counts.delete(key);
      }
      throw error;
    });

  counts.delete(key);
  counts.set(key, { at: Date.now(), promise });
  if (counts.size > MAX_CACHED_USERS) {
    counts.delete(counts.keys().next().value);
  }
  return promise;
}

export default class MediaUserUploadCount extends Component {
  @service currentUser;
  @tracked count = null;

  _mounted = false;
  _requestedUsername = null;
  _sequence = 0;

  get username() {
    return String(this.args.username || "").trim();
  }

  get href() {
    return `/media-library?uploader=${encodeURIComponent(this.username)}`;
  }

  get hasCount() {
    return Number.isSafeInteger(this.count) && this.count > 0;
  }

  @action
  onInsert() {
    // An initially hidden count cannot trigger IntersectionObserver. The card
    // only renders when opened, so request its count directly on insertion.
    // This also works for profiles; the shared cache prevents duplicate calls.
    this._mounted = true;
    this.load();
  }

  @action
  load() {
    const username = this.username;
    if (!this._mounted || !this.currentUser || !username) {
      this._requestedUsername = null;
      this.count = null;
      ++this._sequence;
      return;
    }
    if (this._requestedUsername === username) {
      return;
    }

    this.count = null;
    this._requestedUsername = username;
    const sequence = ++this._sequence;

    countFor(username, this.currentUser.id)
      .then((count) => {
        if (sequence === this._sequence && this.username === username) {
          this.count = count;
        }
      })
      .catch(() => {
        // Inaccessible/disabled Media Library, or a network error: hide link.
        // The backend remains the sole authority on access permissions.
        if (sequence === this._sequence) {
          this.count = null;
        }
      });
  }

  @action
  onDestroy() {
    this._mounted = false;
    this._sequence++;
  }

  <template>
    <span
      class="hb-media-user-upload-count {{if @placement 'hb-media-user-upload-count--card'}} {{if this.hasCount 'hb-media-user-upload-count--visible'}}"
      {{didInsert this.onInsert}}
      {{didUpdate this.load this.username}}
      {{willDestroy this.onDestroy}}
    >
      {{#if this.hasCount}}
        <a class="hb-media-user-upload-count__link" href={{this.href}}>
          <span class="desc">Media uploads</span> {{this.count}}
        </a>
      {{/if}}
    </span>
  </template>
}
