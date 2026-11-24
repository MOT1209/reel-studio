import React from 'react';
import { Composition } from 'remotion';
import { Reel } from './Reel.jsx';

/**
 * One composition for every project: size, fps and length come from the input props
 * ({ projectId, total, fps, width, height }) that the engine passes for each render.
 */
export const Root = () => (
  <Composition
    id="Reel"
    component={Reel}
    durationInFrames={30}
    fps={30}
    width={1080}
    height={1920}
    defaultProps={{ projectId: '', total: 30, fps: 30, width: 1080, height: 1920 }}
    calculateMetadata={({ props }) => ({
      durationInFrames: Math.max(1, Number(props.total) || 1),
      fps: Number(props.fps) || 30,
      width: Number(props.width) || 1080,
      height: Number(props.height) || 1920,
    })}
  />
);
