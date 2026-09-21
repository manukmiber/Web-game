import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { GroundGrid } from './GroundGrid';

/**
 * The grid never uploads anything, so all of it works without a GL context — which is worth the
 * coverage, because what is tested here is the part the 2D view broke.
 *
 * Under perspective the shader's distance fade is measured from the camera and that is exactly
 * right. An orthographic camera sits half a kilometre above a scene it draws at a constant
 * scale, so every fragment is the same distance away and the whole grid fades out at once: the
 * 2D view had no grid at all until `update` learned to take the point being *looked at* instead.
 */
function uniform(grid: GroundGrid, name: string): unknown {
  return ((grid.mesh.material as THREE.ShaderMaterial).uniforms[name] as { value: unknown }).value;
}

describe('GroundGrid', () => {
  it('measures the fade from the camera when nothing else is offered', () => {
    const grid = new GroundGrid();
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(12, 8, -4);
    camera.updateMatrixWorld(true);

    grid.update(camera);

    expect(uniform(grid, 'uCameraPosition')).toMatchObject({ x: 12, y: 8, z: -4 });
    grid.dispose();
  });

  it('measures it from the focus point when one is given', () => {
    const grid = new GroundGrid();
    // Where the 2D view's camera actually is: straight up, far away, and no use at all as a
    // measure of how close anything is.
    const camera = new THREE.OrthographicCamera(-20, 20, 20, -20, 0.1, 2000);
    camera.position.set(30, 500, -70);
    camera.updateMatrixWorld(true);

    grid.update(camera, new THREE.Vector3(30, 0, -70));

    expect(uniform(grid, 'uCameraPosition')).toMatchObject({ x: 30, y: 0, z: -70 });
    grid.dispose();
  });

  it('snaps the quad to the section size so the lattice does not swim', () => {
    const grid = new GroundGrid({ sectionSize: 10 });
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(23.4, 5, -47.9);
    camera.updateMatrixWorld(true);

    grid.update(camera);

    expect(grid.mesh.position.x).toBe(20);
    expect(grid.mesh.position.z).toBe(-50);
    grid.dispose();
  });

  it('resizes the quad with the fade, so its edge is never reachable', () => {
    const grid = new GroundGrid();

    grid.setFade(40, 100);

    expect(uniform(grid, 'uFadeStart')).toBe(40);
    expect(uniform(grid, 'uFadeEnd')).toBe(100);
    expect(grid.mesh.scale.x).toBeGreaterThan(200);
    grid.dispose();
  });

  it('refuses a fade that ends before it starts', () => {
    const grid = new GroundGrid();

    grid.setFade(100, 10);

    const start = uniform(grid, 'uFadeStart') as number;
    expect(uniform(grid, 'uFadeEnd') as number).toBeGreaterThan(start);
    grid.dispose();
  });

  it('puts the fade back where it started when the 2D view hands the grid over', () => {
    const grid = new GroundGrid({ fadeStart: 60, fadeEnd: 260 });

    grid.setFade(5, 9);
    grid.resetFade();

    expect(uniform(grid, 'uFadeStart')).toBe(60);
    expect(uniform(grid, 'uFadeEnd')).toBe(260);
    grid.dispose();
  });
});
