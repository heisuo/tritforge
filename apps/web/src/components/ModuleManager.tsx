import { Boxes, FilePenLine, Pencil, Plus, Trash2 } from "lucide-react";

export interface ModuleManagerModule {
  id: string;
  name: string;
  referenceCount: number;
  placeable: boolean;
}

export interface ModuleManagerProps {
  modules: ModuleManagerModule[];
  activeCircuitKind: "main" | "module";
  onCreate: () => void;
  onEdit: (moduleId: string) => void;
  onPlace: (moduleId: string) => void;
  onRename: (moduleId: string) => void;
  onDelete: (moduleId: string) => void;
  onAddInput: () => void;
  onAddOutput: () => void;
}

export function ModuleManager({
  modules,
  activeCircuitKind,
  onCreate,
  onEdit,
  onPlace,
  onRename,
  onDelete,
  onAddInput,
  onAddOutput,
}: ModuleManagerProps) {
  return (
    <section className="module-manager palette-group" aria-labelledby="module-manager-title">
      <div className="module-manager-heading">
        <h2 id="module-manager-title">工程模块</h2>
        <button type="button" onClick={onCreate}>
          <Plus aria-hidden="true" />
          <span>新建模块</span>
        </button>
      </div>

      {activeCircuitKind === "module" && (
        <div className="module-port-actions">
          <button type="button" onClick={onAddInput}>
            <Plus aria-hidden="true" />
            <span>添加模块输入</span>
          </button>
          <button type="button" onClick={onAddOutput}>
            <Plus aria-hidden="true" />
            <span>添加模块输出</span>
          </button>
        </div>
      )}

      <div className="module-list">
        {modules.map((module) => (
          <div className="module-list-item" key={module.id}>
            <div className="module-list-label">
              <strong>{module.name}</strong>
              <small>{module.referenceCount} 处引用</small>
            </div>
            <div className="module-list-actions">
              <button
                type="button"
                aria-label={`放置 ${module.name}`}
                title="放置模块实例"
                disabled={!module.placeable}
                onClick={() => onPlace(module.id)}
              >
                <Boxes aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={`重命名 ${module.name}`}
                title="重命名模块"
                onClick={() => onRename(module.id)}
              >
                <FilePenLine aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={`编辑 ${module.name}`}
                title="编辑模块定义"
                onClick={() => onEdit(module.id)}
              >
                <Pencil aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={`删除 ${module.name}`}
                onClick={() => onDelete(module.id)}
              >
                <Trash2 aria-hidden="true" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
