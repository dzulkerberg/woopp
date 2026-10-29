import React, { useState } from 'react';
import {
  countCharms,
  countLetters,
  countPlateKeycaps,
  DEFAULT_PLATE_CAPACITY,
  emptyAlphabetMap,
  getProjectTotalTargetQuantity,
  PRIORITIES,
  SALES_CHANNELS,
} from '../constants';
import {
  NavSection,
  ProductionProject,
  ProductionWorkspaceV5,
  ProjectPriority,
  ProjectStatus,
  SalesChannel,
} from '../types';
import { formatDateDDMMYYYY } from '../utils/dateFormat';
import { DateInputDDMMYYYY } from './DateInputDDMMYYYY';

interface ProjectsViewProps {
  workspace: ProductionWorkspaceV5;
  selectedProjectId: string;
  onSelectProject: (projectId: string) => void;
  onSaveProject: (project: ProductionProject, isNew: boolean) => void;
  onUpdateProjectStatus: (projectId: string, status: ProjectStatus) => void;
  onNavigate: (nav: NavSection) => void;
}

export const ProjectsView: React.FC<ProjectsViewProps> = ({
  workspace,
  selectedProjectId,
  onSelectProject,
  onSaveProject,
  onUpdateProjectStatus,
  onNavigate,
}) => {
  const [statusFilter, setStatusFilter] = useState<'Active' | 'Completed' | 'Archived' | 'ALL'>('Active');
  const [editingProject, setEditingProject] = useState<ProductionProject | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [formError, setFormError] = useState('');

  const openNewProjectForm = () => {
    const now = new Date().toISOString();
    const defaultColors = workspace.colors.map((c) => c.id);
    const targetsByColor = Object.fromEntries(
      defaultColors.map((cid) => [cid, emptyAlphabetMap()])
    );
    const carryForwardByColor = Object.fromEntries(
      defaultColors.map((cid) => [cid, emptyAlphabetMap()])
    );
    const allocatedStockByColor = Object.fromEntries(
      defaultColors.map((cid) => [cid, emptyAlphabetMap()])
    );

    setIsCreating(true);
    setFormError('');
    setEditingProject({
      id: `proj-${Date.now()}`,
      name: '',
      salesChannel: 'Klebang Walk',
      priority: 'Normal',
      deadline: '',
      productType: workspace.settings.defaultProductType || '3D Clicker Keycap',
      plateCapacity: workspace.settings.defaultPlateCapacity || DEFAULT_PLATE_CAPACITY,
      assignedColorIds: defaultColors,
      targetQuantity: 414,
      targetsByColor,
      carryForwardByColor,
      allocatedStockByColor,
      status: 'Active',
      notes: '',
      createdIso: now,
      updatedIso: now,
    });
  };

  const openEditProjectForm = (project: ProductionProject) => {
    setIsCreating(false);
    setFormError('');
    setEditingProject({
      ...project,
      assignedColorIds: [...project.assignedColorIds],
    });
  };

  const handleSubmitForm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProject) return;

    const trimmedName = editingProject.name.trim();
    if (!trimmedName) {
      setFormError('Project name is required.');
      return;
    }
    if (editingProject.assignedColorIds.length === 0) {
      setFormError('Assign at least one production color to this project.');
      return;
    }
    if (editingProject.plateCapacity < 1 || editingProject.plateCapacity > 1000) {
      setFormError('Plate capacity must be between 1 and 1000 keycaps.');
      return;
    }

    const targetsByColor = { ...editingProject.targetsByColor };
    const carryForwardByColor = { ...editingProject.carryForwardByColor };
    const allocatedStockByColor = { ...editingProject.allocatedStockByColor };

    for (const cid of editingProject.assignedColorIds) {
      if (!targetsByColor[cid]) targetsByColor[cid] = emptyAlphabetMap();
      if (!carryForwardByColor[cid]) carryForwardByColor[cid] = emptyAlphabetMap();
      if (!allocatedStockByColor[cid]) allocatedStockByColor[cid] = emptyAlphabetMap();
    }

    const plannedTargetSum = editingProject.assignedColorIds.reduce(
      (sum, cid) =>
        sum +
        countLetters(targetsByColor[cid]) +
        countCharms(editingProject.charmTargetsByColor?.[cid]),
      0
    );

    const finalTargetQty =
      plannedTargetSum > 0
        ? plannedTargetSum
        : Math.max(0, Math.floor(Number(editingProject.targetQuantity) || 0));

    onSaveProject(
      {
        ...editingProject,
        name: trimmedName,
        productType: editingProject.productType.trim() || '3D Clicker Keycap',
        plateCapacity: Math.floor(editingProject.plateCapacity),
        targetQuantity: finalTargetQty,
        targetsByColor,
        carryForwardByColor,
        allocatedStockByColor,
        updatedIso: new Date().toISOString(),
      },
      isCreating
    );

    setEditingProject(null);
  };

  const toggleAssignedColor = (colorId: string) => {
    if (!editingProject) return;
    const exists = editingProject.assignedColorIds.includes(colorId);
    const next = exists
      ? editingProject.assignedColorIds.filter((id) => id !== colorId)
      : [...editingProject.assignedColorIds, colorId];
    setEditingProject({ ...editingProject, assignedColorIds: next });
  };

  const visibleProjects = workspace.projects.filter((p) =>
    statusFilter === 'ALL' ? true : p.status === statusFilter
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-1 p-1 bg-neutral-100 dark:bg-[#1a1826] rounded-xl border border-neutral-200/70 dark:border-neutral-800">
          {(['Active', 'Completed', 'Archived', 'ALL'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setStatusFilter(tab)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                statusFilter === tab
                  ? 'bg-white dark:bg-[#2a2440] text-neutral-900 dark:text-white shadow-xs'
                  : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white'
              }`}
            >
              {tab === 'ALL' ? 'All Projects' : tab}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={openNewProjectForm}
          className="px-4 py-2 text-xs font-semibold rounded-lg bg-[#6c4ce6] hover:bg-[#5b3cc4] text-white transition-colors whitespace-nowrap"
        >
          + New Production Project
        </button>
      </div>

      {/* Create / Edit Project Drawer Card */}
      {editingProject && (
        <form
          onSubmit={handleSubmitForm}
          className="bg-white dark:bg-[#171522] border border-neutral-200 dark:border-neutral-800 rounded-2xl p-6 space-y-5"
        >
          <div className="flex items-center justify-between border-b border-neutral-100 dark:border-neutral-800 pb-3">
            <h3 className="text-base font-semibold text-neutral-900 dark:text-white">
              {isCreating ? 'Create Production Project' : `Edit Project: ${editingProject.name}`}
            </h3>
            <button
              type="button"
              onClick={() => setEditingProject(null)}
              className="text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-white"
            >
              Cancel
            </button>
          </div>

          {formError && (
            <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
              {formError}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
                Project Name
              </label>
              <input
                required
                maxLength={100}
                placeholder="e.g. Weekend Booth Restock"
                value={editingProject.name}
                onChange={(e) => setEditingProject({ ...editingProject, name: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#111018] text-sm text-neutral-900 dark:text-white"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
                Sales Channel
              </label>
              <select
                value={editingProject.salesChannel}
                onChange={(e) =>
                  setEditingProject({
                    ...editingProject,
                    salesChannel: e.target.value as SalesChannel,
                  })
                }
                className="w-full px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#111018] text-sm text-neutral-900 dark:text-white"
              >
                {SALES_CHANNELS.map((ch) => (
                  <option key={ch} value={ch}>
                    {ch}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
                Production Priority
              </label>
              <select
                value={editingProject.priority}
                onChange={(e) =>
                  setEditingProject({
                    ...editingProject,
                    priority: e.target.value as ProjectPriority,
                  })
                }
                className="w-full px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#111018] text-sm text-neutral-900 dark:text-white"
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
                Deadline (DD/MM/YYYY)
              </label>
              <DateInputDDMMYYYY
                ariaLabel="Project deadline (DD/MM/YYYY)"
                value={editingProject.deadline}
                onChange={(isoDate) =>
                  setEditingProject({ ...editingProject, deadline: isoDate })
                }
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
                Product Type
              </label>
              <input
                maxLength={80}
                placeholder="3D Clicker Keycap"
                value={editingProject.productType}
                onChange={(e) =>
                  setEditingProject({ ...editingProject, productType: e.target.value })
                }
                className="w-full px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#111018] text-sm text-neutral-900 dark:text-white"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
                Plate Capacity (pcs/plate)
              </label>
              <input
                type="number"
                min={1}
                max={1000}
                value={editingProject.plateCapacity}
                onChange={(e) =>
                  setEditingProject({
                    ...editingProject,
                    plateCapacity: Math.max(1, Number(e.target.value) || DEFAULT_PLATE_CAPACITY),
                  })
                }
                className="w-full px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#111018] text-sm text-neutral-900 dark:text-white font-mono-data"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1.5">
                Assigned Colors
              </label>
              <div className="flex flex-wrap gap-2">
                {workspace.colors.map((c) => {
                  const selected = editingProject.assignedColorIds.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => toggleAssignedColor(c.id)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors flex items-center gap-2 whitespace-nowrap ${
                        selected
                          ? 'border-[#6c4ce6] bg-[#f1edfd] text-[#5b3cc4] dark:bg-[#2a2344] dark:text-[#c7b8ff]'
                          : 'border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400'
                      }`}
                    >
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: c.hex }}
                      />
                      <span>{c.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
                Initial Target Quantity (auto-updates from A–Z &amp; Charm Planner)
              </label>
              <input
                type="number"
                min={0}
                value={editingProject.targetQuantity}
                onChange={(e) =>
                  setEditingProject({
                    ...editingProject,
                    targetQuantity: Math.max(0, Number(e.target.value) || 0),
                  })
                }
                className="w-full px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#111018] text-sm text-neutral-900 dark:text-white font-mono-data"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
              Project Notes
            </label>
            <textarea
              rows={2}
              maxLength={500}
              placeholder="Packaging instructions, booth requirements, or filament brand..."
              value={editingProject.notes}
              onChange={(e) => setEditingProject({ ...editingProject, notes: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-[#111018] text-sm text-neutral-900 dark:text-white"
            />
          </div>

          <div className="flex justify-end gap-2.5">
            <button
              type="button"
              onClick={() => setEditingProject(null)}
              className="px-4 py-2 text-xs font-medium rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-[#6c4ce6] hover:bg-[#5b3cc4] text-white"
            >
              {isCreating ? 'Create Project' : 'Save Changes'}
            </button>
          </div>
        </form>
      )}

      {/* Projects List */}
      {visibleProjects.length === 0 ? (
        <div className="bg-white dark:bg-[#171522] border border-neutral-200 dark:border-neutral-800 rounded-2xl p-10 text-center">
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-4">
            No projects in <span className="font-semibold">{statusFilter}</span> status.
          </p>
          <button
            type="button"
            onClick={openNewProjectForm}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-[#6c4ce6] text-white"
          >
            Create First Project
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {visibleProjects.map((project) => {
            const pJobs = workspace.jobs.filter((j) => j.projectId === project.id);
            const completedJobs = pJobs.filter((j) => j.stage === 'Completed');
            const printingJobs = pJobs.filter((j) => j.stage === 'Printing');
            const producedPcs = completedJobs.reduce(
              (sum, j) => sum + countPlateKeycaps(j),
              0
            );
            const producedLettersPcs = completedJobs.reduce(
              (sum, j) => sum + countLetters(j.letters),
              0
            );
            const producedCharmsPcs = completedJobs.reduce(
              (sum, j) => sum + countCharms(j.charms),
              0
            );
            const allocatedPcs = Object.values(project.allocatedStockByColor || {}).reduce(
              (sum, m) => sum + countLetters(m),
              0
            );
            const plannedJobsPcs = pJobs.reduce(
              (sum, j) => sum + countPlateKeycaps(j),
              0
            );
            const targetPcs =
              getProjectTotalTargetQuantity(project) || plannedJobsPcs;
            const targetCharmsPcs = project.assignedColorIds.reduce(
              (sum, cid) => sum + countCharms(project.charmTargetsByColor?.[cid]),
              0
            );
            const progressPct =
              targetPcs > 0 ? Math.min(100, Math.round((producedPcs / targetPcs) * 100)) : 0;

            const isSelected = project.id === selectedProjectId;

            return (
              <article
                key={project.id}
                className={`bg-white dark:bg-[#171522] border rounded-2xl p-6 transition-colors flex flex-col justify-between ${
                  isSelected
                    ? 'border-[#6c4ce6] dark:border-[#9479ff]'
                    : 'border-neutral-200/80 dark:border-neutral-800'
                }`}
              >
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-base font-semibold text-neutral-900 dark:text-white">
                        {project.name}
                      </h3>
                      <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                        {project.salesChannel} · Priority: {project.priority} · {project.productType}
                      </div>
                    </div>
                    <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400 shrink-0">
                      {project.status}
                    </span>
                  </div>

                  {/* Progress Bar */}
                  <div className="mt-4">
                    <div className="flex items-center justify-between text-xs mb-1.5">
                      <span className="text-neutral-600 dark:text-neutral-300">
                        Printed Progress ({completedJobs.length}/{pJobs.length} plates)
                      </span>
                      <span className="font-mono-data font-semibold text-neutral-900 dark:text-white">
                        {producedPcs.toLocaleString()} / {targetPcs.toLocaleString()} pcs ({progressPct}%)
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-neutral-100 dark:bg-neutral-800 overflow-hidden">
                      <div
                        className="h-full bg-[#6c4ce6]"
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>
                    {(targetCharmsPcs > 0 || producedCharmsPcs > 0) && (
                      <div className="mt-1.5 text-[11px] font-mono-data text-neutral-500 dark:text-neutral-400 flex flex-wrap items-center justify-between gap-2">
                        <span>Alphabet A–Z: {producedLettersPcs.toLocaleString()} printed</span>
                        <span className="text-[#5b3cc4] dark:text-[#c7b8ff]">
                          Charms: {producedCharmsPcs.toLocaleString()} /{' '}
                          {(targetCharmsPcs || producedCharmsPcs).toLocaleString()} printed
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Unboxed Metadata Details */}
                  <div className="mt-4 grid grid-cols-3 gap-3 pt-3 border-t border-neutral-100 dark:border-neutral-800/80 text-xs">
                    <div>
                      <div className="text-neutral-400 dark:text-neutral-500">Deadline</div>
                      <div className="font-mono-data text-neutral-800 dark:text-neutral-200 mt-0.5">
                        {project.deadline ? formatDateDDMMYYYY(project.deadline) : 'Flexible'}
                      </div>
                    </div>
                    <div>
                      <div className="text-neutral-400 dark:text-neutral-500">Plate Cap</div>
                      <div className="font-mono-data text-neutral-800 dark:text-neutral-200 mt-0.5">
                        {project.plateCapacity} pcs
                      </div>
                    </div>
                    <div>
                      <div className="text-neutral-400 dark:text-neutral-500">Reserved Stock</div>
                      <div className="font-mono-data text-neutral-800 dark:text-neutral-200 mt-0.5">
                        {allocatedPcs.toLocaleString()} pcs
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
                    Colors:{' '}
                    {project.assignedColorIds
                      .map((cid) => workspace.colors.find((c) => c.id === cid)?.name)
                      .filter(Boolean)
                      .join(', ') || 'None'}
                    {printingJobs.length > 0 && ` · ${printingJobs.length} currently printing`}
                  </div>

                  {project.notes && (
                    <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400 line-clamp-2">
                      {project.notes}
                    </p>
                  )}
                </div>

                <div className="mt-5 pt-4 border-t border-neutral-100 dark:border-neutral-800 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        onSelectProject(project.id);
                        onNavigate('planner');
                      }}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#f1edfd] text-[#5b3cc4] dark:bg-[#2a2344] dark:text-[#c7b8ff] hover:opacity-90 whitespace-nowrap"
                    >
                      Plan Plates
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onSelectProject(project.id);
                        onNavigate('queue');
                      }}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 whitespace-nowrap"
                    >
                      View Queue
                    </button>
                    <button
                      type="button"
                      onClick={() => openEditProjectForm(project)}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 whitespace-nowrap"
                    >
                      Edit
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    {project.status !== 'Archived' ? (
                      <button
                        type="button"
                        onClick={() => onUpdateProjectStatus(project.id, 'Archived')}
                        className="text-xs text-neutral-500 hover:text-red-600 dark:hover:text-red-400 whitespace-nowrap"
                      >
                        Archive
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onUpdateProjectStatus(project.id, 'Active')}
                        className="text-xs text-[#6c4ce6] dark:text-[#b49eff] hover:underline whitespace-nowrap"
                      >
                        Restore
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
};
