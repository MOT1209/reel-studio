import React from 'react';
import { Composition, registerRoot } from 'remotion';
import { Scene } from './Scene.jsx';
registerRoot(() => <Composition id="Scene" component={Scene} durationInFrames={300} fps={30} width={720} height={1280} />);
