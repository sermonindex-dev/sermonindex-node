import React from 'react';
import { speakerImageCandidates } from '../services/catalog.js';
import defaultSpeaker from '../assets/default-speaker.svg';

export function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).join('').slice(0, 2);
}

/**
 * Speaker portrait with cascading fallbacks.
 * Tries: catalog URL → compact site slug → hyphenated site slug → bundled
 * local placeholder → initials. Handles the site's mixed image-naming
 * conventions. The final fallback is a LOCAL asset (no network request), so
 * the ~420 portrait-less speakers no longer flicker fetching a remote default.
 */
export default function SpeakerAvatar({ speaker, image, className = 'sermon-speaker-avatar' }) {
  const candidates = speakerImageCandidates(speaker, image);
  // No remote candidates → render the bundled placeholder directly (no network).
  // Initials remain the very last resort if even the local asset fails to load.
  if (candidates.length === 0) {
    return (
      <div className={className}>
        <img
          src={defaultSpeaker}
          alt={speaker}
          loading="lazy"
          onError={(e) => {
            e.target.style.display = 'none';
            e.target.parentNode.textContent = getInitials(speaker);
          }}
        />
      </div>
    );
  }
  return (
    <div className={className}>
      <img
        src={candidates[0]}
        alt={speaker}
        loading="lazy"
        data-i="0"
        onError={(e) => {
          const i = Number(e.target.dataset.i) + 1;
          if (i < candidates.length) {
            e.target.dataset.i = String(i);
            e.target.src = candidates[i];
          } else if (e.target.src !== defaultSpeaker && !e.target.dataset.local) {
            // All remote candidates exhausted — fall back to the bundled local
            // placeholder (one final swap; onError won't loop because the next
            // failure is gated by data-local).
            e.target.dataset.local = '1';
            e.target.src = defaultSpeaker;
          } else {
            // Even the local asset failed — initials as the very last resort.
            e.target.style.display = 'none';
            e.target.parentNode.textContent = getInitials(speaker);
          }
        }}
      />
    </div>
  );
}
