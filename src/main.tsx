import React from 'react';
import { createRoot } from 'react-dom/client';
import { Softphone } from './ui/Softphone';
import './styles.css';

const el = document.getElementById('root');
if (!el) throw new Error('#root missing from index.html');

// No StrictMode: it double-invokes effects, and the softphone's mount effect
// registers a SIP device and opens an SSE stream. Registering twice makes the
// second registration evict the first, and the agent silently stops ringing.
createRoot(el).render(<Softphone />);
