import { LAYER_NAMES } from './config.js';

export function createUI() {
  const layerBadge = document.getElementById('layerBadge');
  const entranceInfo = document.getElementById('entranceInfo');

  function setLayerUI(layer) {
    if (!layerBadge) return;
    layerBadge.textContent = `Layer: ${LAYER_NAMES[layer] ?? layer}`;
  }

  function setEntranceInfo(text) {
    if (!entranceInfo) return;
    entranceInfo.textContent = text;
    entranceInfo.classList.remove('ghost');
  }

  return { setLayerUI, setEntranceInfo };
}
