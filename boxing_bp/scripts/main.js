import { world, system, EntityComponentTypes } from "@minecraft/server";

// ==========================================
// CONFIGURATION & GLOBAL STATE (MC BEDROCK 1.26.44+)
// ==========================================
const STAMINA_MAX = 100;
const STAMINA_REGEN = 5;
const STAMINA_ATTACK_COST = 10;
const STAMINA_HEAVY_COST = 25;
const STAMINA_GUARD_COST = 15;

const playerStamina = new Map();     // playerId -> stamina
const playerGuardTime = new Map();   // playerId -> timestamp
const playerGuardHits = new Map();   // playerId -> consecutive guard hit count
const playerStunState = new Map();   // playerId -> stun end timestamp
const playerPunchArm = new Map();    // playerId -> "left" | "right"
const cameraActive = new Map();      // playerId -> boolean
const lockedLocations = new Map();   // entityId -> { x, y, z, dimension, until }
const lastPunchTime = new Map();     // playerId -> timestamp

// Helper: Get Health Component
function getHealthComponent(entity) {
  try {
    return entity.getComponent(EntityComponentTypes.Health);
  } catch (e) {
    return null;
  }
}

// Helper: Get Entity Health
function getHealth(entity) {
  const hpComp = getHealthComponent(entity);
  return hpComp ? hpComp.currentValue : 20;
}

// Helper: Set Entity Health
function setHealth(entity, value) {
  const hpComp = getHealthComponent(entity);
  if (hpComp) {
    const targetValue = Math.max(1, Math.min(value, hpComp.effectiveMax));
    hpComp.setCurrentValue(targetValue);
  }
}

// Check if player is currently stunned
function isStunned(player) {
  const stunEnd = playerStunState.get(player.id);
  if (!stunEnd) return false;
  if (Date.now() > stunEnd) {
    playerStunState.delete(player.id);
    return false;
  }
  return true;
}

// Lock entity location during cinematic / stun
function lockEntityPosition(entity, durationMs) {
  if (!entity) return;
  const loc = entity.location;
  lockedLocations.set(entity.id, {
    x: loc.x,
    y: loc.y,
    z: loc.z,
    dimension: entity.dimension,
    until: Date.now() + durationMs
  });
}

// Find nearest opponent within radius
function getNearestOpponent(player, radius = 6) {
  const playerLoc = player.location;
  let closest = null;
  let minDistanceSq = radius * radius;

  try {
    for (const other of player.dimension.getEntities()) {
      if (other.id === player.id) continue;
      const loc = other.location;
      const dx = loc.x - playerLoc.x;
      const dy = loc.y - playerLoc.y;
      const dz = loc.z - playerLoc.z;
      const distSq = dx * dx + dy * dy + dz * dz;

      if (distSq <= minDistanceSq) {
        minDistanceSq = distSq;
        closest = other;
      }
    }
  } catch (e) {}
  return closest;
}

// ==========================================
// 1. PLAYER MOVEMENT & CAMERA SYSTEM (1.26+)
// ==========================================
// Set tactical walking speed dynamically via valid Bedrock attribute generic.movement_speed
system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    if (!player.hasTag("boxing_speed_126_ok")) {
      player.addTag("boxing_speed_126_ok");
      player.runCommandAsync(`attribute @s generic.movement_speed base set 0.07`);
    }
  }
}, 20);

// Over-The-Shoulder Camera Control (Bedrock 1.26.44+ Compatible)
system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    const isCam = cameraActive.get(player.id) ?? true;
    if (isCam && !isStunned(player)) {
      try {
        const loc = player.location;
        const rot = player.getRotation();
        const yawRad = (rot.y * Math.PI) / 180;

        const forwardX = -Math.sin(yawRad);
        const forwardZ = Math.cos(yawRad);
        const rightX = Math.cos(yawRad);
        const rightZ = Math.sin(yawRad);

        const camX = loc.x - forwardX * 2.2 + rightX * 0.7;
        const camY = loc.y + 1.8;
        const camZ = loc.z - forwardZ * 2.2 + rightZ * 0.7;

        const targetX = loc.x + forwardX * 3.0;
        const targetY = loc.y + 1.5;
        const targetZ = loc.z + forwardZ * 3.0;

        try {
          player.camera.setCamera("boxing:over_shoulder", {
            location: { x: camX, y: camY, z: camZ },
            facingLocation: { x: targetX, y: targetY, z: targetZ }
          });
        } catch (e) {
          player.camera.setCamera("minecraft:free", {
            location: { x: camX, y: camY, z: camZ },
            facingLocation: { x: targetX, y: targetY, z: targetZ }
          });
        }
      } catch (e) {}
    }
  }
}, 2);

// Position Lock for Cutscenes & Stun States
system.runInterval(() => {
  const now = Date.now();
  for (const [entityId, lockData] of lockedLocations.entries()) {
    if (now > lockData.until) {
      lockedLocations.delete(entityId);
      continue;
    }
    const dim = lockData.dimension || world.getDimension("overworld");
    try {
      for (const ent of dim.getEntities()) {
        if (ent.id === entityId) {
          const cur = ent.location;
          const distSq = (cur.x - lockData.x) ** 2 + (cur.y - lockData.y) ** 2 + (cur.z - lockData.z) ** 2;
          if (distSq > 0.15) {
            ent.teleport({ x: lockData.x, y: lockData.y, z: lockData.z }, { dimension: ent.dimension });
          }
        }
      }
    } catch (e) {}
  }
}, 2);

// ==========================================
// 2. ITEM USE & SLOW-MO SKILLS
// ==========================================
world.afterEvents.itemUse.subscribe((event) => {
  const player = event.source;
  const item = event.itemStack;
  if (!player || !item) return;

  // Boxing Gloves: Perform punch attack
  if (item.typeId === "boxing:gloves") {
    performPunch(player);
  }

  // Skill 1: Dash Slow-Mo
  if (item.typeId === "boxing:skill_dash") {
    triggerDashSlowMo(player);
  }

  // Skill 2: Counter Slow-Mo
  if (item.typeId === "boxing:skill_counter") {
    triggerCounterSlowMo(player);
  }
});

// Synced Cinematic Slow-Mo: Dash
function triggerDashSlowMo(player) {
  if (isStunned(player)) return;

  const opponent = getNearestOpponent(player, 6);
  const durationMs = 3000;

  lockEntityPosition(player, durationMs);
  if (opponent) {
    lockEntityPosition(opponent, durationMs);
  }

  player.runCommandAsync(`playanimation @s animation.player.dash_slowmo default 1`);
  player.runCommandAsync(`playsound game.player.attack.nodamage @a ~ ~ ~ 0.8 0.8`);
  player.onScreenDisplay.setActionBar("§b⚡ CINEMATIC SLOW-MO: DASH!");

  if (opponent && opponent.typeId === "minecraft:player") {
    opponent.runCommandAsync(`playanimation @s animation.player.dash_slowmo default 1`);
    opponent.onScreenDisplay.setActionBar("§e⚡ OPPONENT DASH SLOW-MO!");
  }

  world.sendMessage(`§b[Cinematic] §e${player.nameTag || "นักมวย"} พุ่งหลบแบบสโลว์โมชัน!`);
}

// Synced Cinematic Slow-Mo: Counter
function triggerCounterSlowMo(player) {
  if (isStunned(player)) return;

  const opponent = getNearestOpponent(player, 6);
  const durationMs = 3500;

  lockEntityPosition(player, durationMs);
  if (opponent) {
    lockEntityPosition(opponent, durationMs);
  }

  player.runCommandAsync(`playanimation @s animation.player.counter_slowmo default 1`);
  player.runCommandAsync(`playsound game.player.attack.strong @a ~ ~ ~ 1.0 0.6`);
  player.onScreenDisplay.setActionBar("§c💥 CINEMATIC SLOW-MO: COUNTER PUNCH!");

  if (opponent && opponent.typeId === "minecraft:player") {
    opponent.runCommandAsync(`playanimation @s animation.player.punch_right default 1`);
    opponent.onScreenDisplay.setActionBar("§c⚠️ คุณกำลังโดนหมัดสวน Counter Slow-Mo!");
  }

  system.runTimeout(() => {
    if (opponent) {
      const oppHp = getHealth(opponent);
      setHealth(opponent, Math.max(1, oppHp - 10));
      opponent.runCommandAsync(`playsound random.hurt @a ~ ~ ~ 1.0 0.8`);
    }
  }, 40);

  world.sendMessage(`§c[Cinematic] §e${player.nameTag || "นักมวย"} สวนหมัด Counter Slow-Mo!`);
}

// ==========================================
// 3. COMBAT MECHANICS (M1 LIGHT PUNCH / M2 HEAVY PUNCH / GUARD BREAK)
// ==========================================

// Trigger punch animation & stamina on player attack
function performPunch(player) {
  if (!player || isStunned(player)) return;

  const now = Date.now();
  const lastPunch = lastPunchTime.get(player.id) || 0;
  if (now - lastPunch < 200) return;
  lastPunchTime.set(player.id, now);

  const isSneaking = player.isSneaking;

  if (isSneaking) {
    // M2 Heavy Punch (Sneak + Punch)
    player.runCommandAsync(`playanimation @s animation.player.heavy_punch default 1`);
    player.runCommandAsync(`playsound game.player.attack.strong @a ~ ~ ~ 1.2 0.7`);
    player.onScreenDisplay.setActionBar("§c💥 M2 HEAVY PUNCH (หมัดหนักทะลุการ์ด!)");

    let stamina = playerStamina.get(player.id) ?? STAMINA_MAX;
    stamina = Math.max(0, stamina - STAMINA_HEAVY_COST);
    playerStamina.set(player.id, stamina);
  } else {
    // M1 Light Punch (Alternating Left / Right Punch)
    const lastArm = playerPunchArm.get(player.id) || "right";
    const nextArm = lastArm === "left" ? "right" : "left";
    playerPunchArm.set(player.id, nextArm);

    const anim = nextArm === "left" ? "animation.player.punch_left" : "animation.player.punch_right";
    player.runCommandAsync(`playanimation @s ${anim} default 1`);
    player.runCommandAsync(`playsound game.player.attack.nodamage @a ~ ~ ~ 0.9 1.1`);

    let stamina = playerStamina.get(player.id) ?? STAMINA_MAX;
    stamina = Math.max(0, stamina - STAMINA_ATTACK_COST);
    playerStamina.set(player.id, stamina);
  }
}

// Trigger punch animation on block interact / attack swing
world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
  if (event.player) {
    performPunch(event.player);
  }
});

// Process Combat Hits & Guard Break
world.afterEvents.entityHurt.subscribe((event) => {
  const victim = event.hurtEntity;
  const attacker = event.damageSource.damagingEntity;
  let damage = event.damage;

  if (!victim) return;

  const currentHp = getHealth(victim);
  const hpComp = getHealthComponent(victim);
  const maxHp = hpComp ? hpComp.effectiveMax : 20;

  if (attacker && attacker.typeId === "minecraft:player" && !isStunned(attacker)) {
    performPunch(attacker);

    // M2 Heavy Punch pierces guard
    if (attacker.isSneaking && victim.typeId === "minecraft:player") {
      const isVictimGuarding = victim.isSneaking || playerGuardTime.has(victim.id);
      if (isVictimGuarding) {
        triggerGuardBreak(victim);
        victim.sendMessage("§c💥 คุณถูก M2 Heavy Punch ชกทะลุการ์ดจนการ์ดแตก!");
      }
    }
  }

  // Victim Guard Calculation
  if (victim.typeId === "minecraft:player" && !isStunned(victim)) {
    const isGuarding = victim.isSneaking || playerGuardTime.has(victim.id);
    const isAttackerSneaking = attacker && attacker.isSneaking;

    if (isGuarding && !isAttackerSneaking) {
      let hits = (playerGuardHits.get(victim.id) || 0) + 1;
      playerGuardHits.set(victim.id, hits);

      let stamina = playerStamina.get(victim.id) ?? STAMINA_MAX;
      stamina = Math.max(0, stamina - STAMINA_GUARD_COST);
      playerStamina.set(victim.id, stamina);

      if (hits >= 3 || stamina <= 0) {
        triggerGuardBreak(victim);
        return;
      }

      // Refund 80% damage on normal guard block
      const refundedDamage = damage * 0.8;
      setHealth(victim, Math.min(maxHp, currentHp + refundedDamage));
      victim.runCommandAsync(`playsound game.player.attack.nodamage @a ~ ~ ~ 0.8 1.0`);
      victim.onScreenDisplay.setActionBar(`§b🛡️ ตั้งการ์ดบล็อก (${hits}/3)`);
      return;
    }
  }

  victim.runCommandAsync(`playsound random.hurt @a ~ ~ ~ 0.8 1.0`);
});

// Trigger Guard Break Stun
function triggerGuardBreak(player) {
  const stunDurationMs = 3000;
  playerStunState.set(player.id, Date.now() + stunDurationMs);
  playerGuardHits.set(player.id, 0);

  lockEntityPosition(player, stunDurationMs);

  player.runCommandAsync(`playanimation @s animation.player.stunned default 1`);
  player.runCommandAsync(`playsound random.hurt @a ~ ~ ~ 1.0 0.5`);
  player.onScreenDisplay.setActionBar("§c💫 GUARD BREAK! (ติดสถานะ Stun มึนชั่วคราว)");
  player.sendMessage("§c💫 [Guard Break] การ์ดของคุณแตก! ติดสถานะ Stun ยืนมึน 3 วินาที");
}

// Tracking Sneak & Guarding State
system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    if (isStunned(player)) {
      player.runCommandAsync(`playanimation @s animation.player.stunned default 1`);
      player.onScreenDisplay.setActionBar("§c💫 GUARD BREAK! ติดสถานะ Stun มึนชั่วคราว");
      continue;
    }

    if (player.isSneaking) {
      if (!playerGuardTime.has(player.id)) {
        playerGuardTime.set(player.id, Date.now());
      }
    } else {
      const last = playerGuardTime.get(player.id);
      if (last && Date.now() - last > 1000) {
        playerGuardTime.delete(player.id);
        playerGuardHits.set(player.id, 0);
      }
    }
  }
}, 5);

// Stamina Regeneration & Actionbar Display
system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    let stamina = playerStamina.get(player.id) ?? STAMINA_MAX;

    if (stamina < STAMINA_MAX && !player.isSneaking && !isStunned(player)) {
      stamina = Math.min(STAMINA_MAX, stamina + STAMINA_REGEN);
      playerStamina.set(player.id, stamina);
    }

    if (!isStunned(player)) {
      const bars = Math.floor((stamina / STAMINA_MAX) * 10);
      const progressBar = "█".repeat(bars) + "▒".repeat(10 - bars);
      const color = stamina > 30 ? "§a" : "§c";
      player.onScreenDisplay.setActionBar(`⚡ Stamina: ${color}[${progressBar}] ${stamina}/${STAMINA_MAX}`);
    }
  }
}, 10);
