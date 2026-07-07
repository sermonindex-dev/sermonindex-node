import React from 'react';
import { speakerImageCandidates } from '../services/catalog.js';

export function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).join('').slice(0, 2);
}

/**
 * Speaker portrait with cascading fallbacks.
 * Tries: catalog URL → compact site slug → hyphenated site slug → CDN
 * placeholder → initials. Handles the site's mixed image-naming conventions.
 */
export default function SpeakerAvatar({ speaker, image, className = 'sermon-speaker-avatar' }) {
  const candidates = speakerImageCandidates(speaker, image);
  if (candidates.length === 0) {
    return <div className={className}>{getInitials(speaker)}</div>;
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
          } else {
            e.target.style.display = 'none';
            e.target.parentNode.textContent = getInitials(speaker);
          }
        }}
      />
    </div>
  );
}
