// Publishes only the values that changed since the previous publication
// (Gladys limits state updates to 300/min per integration).
export function createChangePublisher({ ids, publishStates }) {
  const last = new Map();
  return {
    async publish(readings) {
      const states = [];
      for (const [key, value] of Object.entries(readings)) {
        if (value === null || value === undefined) continue;
        const id = ids.feature(key);
        const state = typeof value === "boolean" ? Number(value) : value;
        if (last.get(id) === state) continue;
        states.push({ device_feature_external_id: id, state });
      }
      if (states.length === 0) return 0;
      await publishStates(states);
      for (const s of states) last.set(s.device_feature_external_id, s.state); // remember only after success
      return states.length;
    },
    /** Forget what was sent, e.g. after the user created the device: everything goes again. */
    reset() {
      last.clear();
    },
  };
}
