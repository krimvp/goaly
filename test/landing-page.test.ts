import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import type { HTMLButtonElement, HTMLElement } from 'happy-dom';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');

function openPage(reducedMotion: boolean): Window {
  const window = new Window({
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    },
  });
  window.matchMedia = (() => ({
    matches: reducedMotion,
    addEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  window.document.write(html);
  return window;
}

describe('landing page loop', () => {
  it('shows every step and lets keyboard users inspect the loop', () => {
    const window = openPage(false);
    const buttons = [...window.document.querySelectorAll('.step-button')] as HTMLButtonElement[];
    const detail = window.document.querySelector('#step-detail');
    const visual = window.document.querySelector('#loop-visual') as HTMLElement;

    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      '1 · Set checks',
      '2 · Try the work',
      '3 · Review result',
    ]);
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true');
    buttons[0]?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(buttons[2]?.getAttribute('aria-pressed')).toBe('true');
    expect(window.document.activeElement).toBe(buttons[2]);
    expect(detail?.textContent).toContain('final review');
    expect(visual.dataset.step).toBe('2');

    buttons[1]?.click();
    expect(buttons[1]?.getAttribute('aria-pressed')).toBe('true');
    expect(detail?.textContent).toContain('another try');
    expect(visual.dataset.step).toBe('1');
    window.close();
  });

  it('lets users pause the animation and starts still for reduced motion', () => {
    for (const reducedMotion of [false, true]) {
      const window = openPage(reducedMotion);
      const visual = window.document.querySelector('#loop-visual') as HTMLElement;
      const motion = window.document.querySelector('#motion-toggle') as HTMLButtonElement;
      expect(visual.classList.contains('is-paused')).toBe(reducedMotion);
      expect(motion.getAttribute('aria-pressed')).toBe(String(reducedMotion));
      motion.click();
      expect(visual.classList.contains('is-paused')).toBe(!reducedMotion);
      expect(motion.textContent).toBe(reducedMotion ? 'Pause animation' : 'Play animation');
      window.close();
    }
  });
});
