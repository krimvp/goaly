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
    const screens = [...window.document.querySelectorAll('.screen-panel')] as HTMLElement[];

    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      '1 · Set checks',
      '2 · Try the work',
      '3 · Review result',
    ]);
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(screens[0]?.getAttribute('aria-hidden')).toBe('false');
    expect(screens[0]?.textContent).toContain('GET /health returns 200');
    buttons[0]?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(buttons[2]?.getAttribute('aria-pressed')).toBe('true');
    expect(window.document.activeElement).toBe(buttons[2]);
    expect(detail?.textContent).toContain('final review');
    expect(visual.dataset.step).toBe('2');
    expect(screens[2]?.classList.contains('is-active')).toBe(true);
    expect(screens[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(screens[2]?.textContent).toContain('200');
    expect(screens[2]?.textContent).toContain('review');

    buttons[1]?.click();
    expect(buttons[1]?.getAttribute('aria-pressed')).toBe('true');
    expect(detail?.textContent).toContain('another try');
    expect(visual.dataset.step).toBe('1');
    expect(screens[1]?.classList.contains('is-active')).toBe(true);
    expect(screens[2]?.getAttribute('aria-hidden')).toBe('true');
    expect(screens[1]?.textContent).toContain('404');
    window.close();
  });

  it('keeps manual screen selection available with reduced motion', () => {
    for (const reducedMotion of [false, true]) {
      const window = openPage(reducedMotion);
      const visual = window.document.querySelector('#loop-visual') as HTMLElement;
      const buttons = [...window.document.querySelectorAll('.step-button')] as HTMLButtonElement[];
      expect(window.document.querySelector('#motion-toggle')).toBeNull();
      buttons[2]?.click();
      expect(visual.dataset.step).toBe('2');
      expect(buttons[2]?.getAttribute('aria-pressed')).toBe('true');
      window.close();
    }
  });
});
