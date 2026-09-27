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
  window.matchMedia = (() => ({ matches: reducedMotion })) as unknown as typeof window.matchMedia;
  window.document.write(html);
  return window;
}

describe('landing page loop', () => {
  it('shows every step and lets keyboard users inspect the loop', () => {
    const window = openPage(false);
    const buttons = [...window.document.querySelectorAll('.step-button')] as HTMLButtonElement[];
    const detail = window.document.querySelector('#step-detail');

    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      '01 Compile checks ↗',
      '02 Freeze the bar ↗',
      '03 Run and verify ↗',
      '04 Sign off or retry ↗',
    ]);
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true');
    buttons[0]?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(buttons[3]?.getAttribute('aria-pressed')).toBe('true');
    expect(window.document.activeElement).toBe(buttons[3]);
    expect(detail?.textContent).toContain('DONE needs both');

    buttons[1]?.click();
    expect(buttons[1]?.getAttribute('aria-pressed')).toBe('true');
    expect(detail?.textContent).toContain('frozen and logged');
    window.close();
  });

  it('tilts on pointer input and stays still for reduced motion', () => {
    for (const reducedMotion of [false, true]) {
      const window = openPage(reducedMotion);
      const scene = window.document.querySelector('#loop-scene') as HTMLElement | null;
      expect(scene).not.toBeNull();
      if (!scene) throw new Error('loop scene is missing');
      scene.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 }) as ReturnType<typeof scene.getBoundingClientRect>;
      scene.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 150, clientY: 50 }));
      expect(scene.style.getPropertyValue('--ry')).toBe(reducedMotion ? '' : '2.50deg');
      scene.dispatchEvent(new window.PointerEvent('pointerleave'));
      expect(scene.style.getPropertyValue('--ry')).toBe(reducedMotion ? '' : '0deg');
      window.close();
    }
  });
});
