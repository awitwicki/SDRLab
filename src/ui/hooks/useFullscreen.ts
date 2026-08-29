import { useCallback, useEffect, useState } from 'react';

interface Fullscreen {
  isFullscreen: boolean;
  /** False where the browser refuses fullscreen entirely, e.g. Safari on iPhone. */
  supported: boolean;
  toggle: () => Promise<void>;
}

/** Drives whole-document fullscreen, tracking changes made outside the app too. */
export default function useFullscreen(): Fullscreen {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    setSupported(Boolean(document.fullscreenEnabled));
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    onChange();
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggle = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      // Rejected when not driven by a user gesture, or blocked by policy.
      // Nothing to recover: the button simply has no effect.
    }
  }, []);

  return { isFullscreen, supported, toggle };
}
