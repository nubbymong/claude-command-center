// Runs the renderer composition root at module load. The renderer entry
// imports this module ABOVE `App`, so every descriptor is registered before
// any module-level code in App's import graph can look one up.
import { composeRendererProviders } from './index'

composeRendererProviders()
