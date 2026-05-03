// Minimal column-major 4x4 matrix helpers and the cameras built on them. World axes: x right,
// y "down" the 2D map, z up. Every 3D view renders and projects through one view-projection
// matrix, so WebGL, the overlay and picking agree exactly.

// The world is left-handed (y runs down the map, z up), so x is negated to keep the map unmirrored.
export function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far);
  return new Float32Array([-f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

export function lookAt([ex, ey, ez], [tx, ty, tz], [ux, uy, uz] = [0, 0, 1]) {
  let zx = ex - tx, zy = ey - ty, zz = ez - tz;
  let len = Math.hypot(zx, zy, zz) || 1; zx /= len; zy /= len; zz /= len;
  let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
  len = Math.hypot(xx, xy, xz);
  if (len < 1e-6) { xx = 1; xy = 0; xz = 0; len = 1; } // looking straight along up
  xx /= len; xy /= len; xz /= len;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
    -(xx * ex + xy * ey + xz * ez), -(yx * ex + yy * ey + yz * ez), -(zx * ex + zy * ey + zz * ez), 1,
  ]);
}

export function multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return out;
}

// Clip coordinates of a world point.
export function transform(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
}

// Unit view direction for a yaw (around z, 0 = looking toward -y) and pitch (up positive).
export function direction(yaw, pitch) {
  return [-Math.sin(yaw) * Math.cos(pitch), -Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch)];
}

// Orbit camera matching the original landscape projection: focal length 2.7, world scaled by
// 1/scale, with the view lifted by `lift` along the camera's up axis. `pitch` is the elevation.
export function orbitPose({ x, y, yaw, pitch, distance }, scale = 420, lift = .35) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), d = distance * scale;
  const up = [-sy * sp, -cy * sp, cp], shift = lift * scale;
  const target = [x + up[0] * shift, y + up[1] * shift, up[2] * shift];
  return { eye: [target[0] + sy * cp * d, target[1] + cy * cp * d, target[2] + sp * d], target, up };
}

export const ORBIT_FOV = 2 * Math.atan(1 / 2.7);
