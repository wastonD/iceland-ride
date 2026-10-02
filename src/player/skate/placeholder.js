// 占位滑板人：真正的角色（src/skater/character.js）缺失或加载失败时使用。
// 约定同 createSkater：root 原点 = 板面中心，+Z = 板头，+Y = 上；update(dt, rideState) 每帧调用。

export function createPlaceholderSkater(ctx) {
  const { THREE } = ctx;
  const root = new THREE.Group();
  root.name = 'skater-placeholder';

  const mk = (color, rough = 0.7) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.05 });
    ctx.prepareMaterial?.(m, { wet: true });
    return m;
  };

  // 板：长 1.0 m、宽 0.24 m，四个轮子
  const board = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.025, 1.0), mk(0xc9a26b, 0.55));
  board.position.y = -0.02;
  board.castShadow = true;
  root.add(board);
  const wheelGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.04, 12);
  const wheelMat = mk(0xe8e2d0, 0.5);
  for (const [x, z] of [[-0.1, -0.32], [0.1, -0.32], [-0.1, 0.32], [0.1, 0.32]]) {
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, -0.07, z);
    root.add(w);
  }

  // 人：胶囊身体 + 头，侧身站立（面向 +X 侧）
  const body = new THREE.Group();
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.62, 4, 10), mk(0x35608a, 0.85));
  torso.castShadow = true;
  torso.position.y = 0.72;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 10), mk(0xd9b08c, 0.8));
  head.position.y = 1.32;
  body.add(torso, head);
  root.add(body);

  function update(dt, ride) {
    const c = ride.crouch || 0;
    body.scale.y = 1 - 0.28 * c;
    // 蹬地时身体略前倾
    body.rotation.x = (ride.pushing ? 0.12 * Math.sin(ride.pushPhase * Math.PI) : 0) + 0.25 * c;
  }

  return { root, update, placeholder: true };
}
