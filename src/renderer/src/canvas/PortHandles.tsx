// Editor only: six small dots on the hexagon's edge midpoints (the docking ports). Drag from one onto another node to
// connect them; the dot you start from becomes the connector's source port.
import { Handle, Position } from '@xyflow/react'
import { PORT_ANGLE, PORT_ORDER, inradius } from '@shared/geometry/hex.ts'
import type { Point } from '@shared/geometry/hex.ts'

export function PortHandles({ center, r, squash }: { center: Point; r: number; squash: number }): React.JSX.Element {
  const h = inradius(r)
  return (
    <>
      {PORT_ORDER.map((p) => {
        const a = PORT_ANGLE[p]
        return (
          <Handle
            key={p}
            id={p}
            type="source"
            position={Position.Top}
            className="hx-port"
            style={{ left: center.x + h * Math.cos(a), top: center.y + h * Math.sin(a) * squash }}
            title="Drag to another node to connect"
          />
        )
      })}
    </>
  )
}
