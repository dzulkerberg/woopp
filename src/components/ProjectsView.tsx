import React, { useState } from 'react';
import {
  computeProjectPlateProgress,
  countLetters,
  DEFAULT_PLATE_CAPACITY,
  emptyAlphabetMap,
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

    onSaveProject(
      {
        ...editingProject,
        name: trimmedName,
        productType: editingProject.productType.trim() || '3D Clicker Keycap',
        plateCapacity: Math.floor(editingProject.plateCapacity),
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
        <div className="flex items-center gap-1 p-1 bg-recessed rounded-lg border border-line">
          {(['Active', 'Completed', 'Archived', 'ALL'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setStatusFilter(tab)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                statusFilter === tab
                  ? 'bg-surface text-ink border border-line shadow-xs font-semibold'
                  : 'border border-transparent text-ink-secondary hover:text-ink'
              }`}
            >
              {tab === 'ALL' ? 'All Projects' : tab}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={openNewProjectForm}
          className="px-4 py-2 text-xs font-semibold rounded-lg bg-brand hover:bg-brand-hover text-white transition-colors whitespace-nowrap"
        >
          + New Production Project
        </button>
      </div>

      {/* Create / Edit Project Drawer Card */}
      {editingProject && (
        <form
          onSubmit={handleSubmitForm}
          className="bg-surface border border-line rounded-xl p-6 space-y-5"
        >
          <div className="flex items-center justify-between border-b border-line pb-3">
            <h3 className="text-base font-semibold text-ink">
              {isCreating ? 'Create Production Project' : `Edit Project: ${editingProject.name}`}
            </h3>
            <button
              type="button"
              onClick={() => setEditingProject(null)}
              className="text-xs text-muted hover:text-ink transition-colors"
            >
              Cancel
            </button>
          </div>

          {formError && (
            <div className="p-3 rounded-lg bg-error-soft border border-error-border text-xs text-error-text">
              {formError}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-semibold text-ink-secondary mb-1">
                Project Name
              </label>
              <input
                required
                maxLength={100}
                placeholder="e.g. Weekend Booth Restock"
                value={editingProject.name}
                onChange={(e) => setEditingProject({ ...editingProject, name: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-line bg-input text-sm text-ink placeholder:text-muted focus:border-brand"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-ink-secondary mb-1">
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
                className="w-full px-3 py-2 rounded-lg border border-line bg-input text-sm text-ink focus:border-brand"
              >
                {SALES_CHANNELS.map((ch) => (
                  <option key={ch} value={ch}>
                    {ch}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-ink-secondary mb-1">
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
                className="w-full px-3 py-2 rounded-lg border border-line bg-input text-sm text-ink focus:border-brand"
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-ink-secondary mb-1">
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
              <label className="block text-xs font-semibold text-ink-secondary mb-1">
                Product Type
              </label>
              <input
                maxLength={80}
                placeholder="3D Clicker Keycap"
                value={editingProject.productType}
                onChange={(e) =>
                  setEditingProject({ ...editingProject, productType: e.target.value })
                }
                className="w-full px-3 py-2 rounded-lg border border-line bg-input text-sm text-ink placeholder:text-muted focus:border-brand"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-ink-secondary mb-1">
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
                className="w-full px-3 py-2 rounded-lg border border-line bg-input text-sm text-ink font-mono-data focus:border-brand"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-ink-secondary mb-1.5">
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
                        ? 'border-brand bg-brand-soft text-brand-text font-semibold'
                        : 'border-line bg-surface text-ink-secondary hover:text-ink hover:bg-elevated'
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
            <label className="block text-xs font-semibold text-ink-secondary mb-1">
              Project Notes
            </label>
            <textarea
              rows={2}
              maxLength={500}
              placeholder="Packaging instructions, booth requirements, or filament brand..."
              value={editingProject.notes}
              onChange={(e) => setEditingProject({ ...editingProject, notes: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-line bg-input text-sm text-ink placeholder:text-muted focus:border-brand"
            />
          </div>

          <div className="flex justify-end gap-2.5">
            <button
              type="button"
              onClick={() => setEditingProject(null)}
              className="px-4 py-2 text-xs font-medium rounded-lg border border-line bg-surface hover:bg-elevated text-ink-secondary hover:text-ink transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-brand hover:bg-brand-hover text-white transition-colors"
            >
              {isCreating ? 'Create Project' : 'Save Changes'}
            </button>
          </div>
        </form>
      )}

      {/* Projects List */}
      {visibleProjects.length === 0 ? (
        <div className="bg-surface border border-line rounded-xl p-10 text-center">
          <p className="text-sm text-muted mb-4">
            No projects in <span className="font-semibold text-ink">{statusFilter}</span> status.
          </p>
          <button
            type="button"
            onClick={openNewProjectForm}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-brand hover:bg-brand-hover text-white transition-colors"
          >
            Create First Project
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {visibleProjects.map((project) => {
            const progress = computeProjectPlateProgress(workspace.jobs, project.id);
            const allocatedPcs = Object.values(project.allocatedStockByColor || {}).reduce(
              (sum, m) => sum + countLetters(m),
              0
            );

            const isSelected = project.id === selectedProjectId;

            return (
              <article
                key={project.id}
                className={`bg-surface border rounded-xl p-6 transition-colors flex flex-col justify-between ${
                  isSelected
                    ? 'border-brand ring-1 ring-brand/25'
                    : 'border-line'
                }`}
              >
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-base font-semibold text-ink">
                        {project.name}
                      </h3>
                      <div className="text-xs text-muted mt-0.5">
                        {project.salesChannel} · Priority: {project.priority} · {project.productType}
                      </div>
                    </div>
                    <span
                      className={`px-2 py-0.5 rounded-md border text-[11px] font-semibold shrink-0 ${
                        project.status === 'Completed'
                          ? 'border-brand-border bg-brand-soft text-brand-text'
                          : project.status === 'Archived'
                          ? 'border-line bg-recessed text-muted'
                          : 'border-info-border bg-info-soft text-info-text'
                      }`}
                    >
                      {project.status}
                    </span>
                  </div>

                  {/* Progress Bar (driven strictly by valid plate records) */}
                  <div className="mt-4">
                    <div className="flex items-center justify-between text-xs mb-1.5">
                      <span className="text-ink-secondary">
                        Printed Progress ({progress.completedPlates}/{progress.totalValidPlates} plates)
                      </span>
                      <span className="font-mono-data font-semibold text-ink">
                        {progress.producedKeycaps.toLocaleString()} / {progress.plannedKeycaps.toLocaleString()} pcs ({progress.progressPct}%)
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-recessed border border-line/60 overflow-hidden">
                      <div
                        className="h-full bg-brand transition-all"
                        style={{ width: `${progress.progressPct}%` }}
                      />
                    </div>
                    {(progress.plannedCharms > 0 || progress.producedCharms > 0) && (
                      <div className="mt-1.5 text-[11px] font-mono-data text-muted flex flex-wrap items-center justify-between gap-2">
                        <span>
                          Alphabet A–Z: {progress.producedLetters.toLocaleString()} /{' '}
                          {progress.plannedLetters.toLocaleString()} printed
                        </span>
                        <span className="text-brand-text font-semibold">
                          Charms: {progress.producedCharms.toLocaleString()} /{' '}
                          {progress.plannedCharms.toLocaleString()} printed
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Unboxed Metadata Details */}
                  <div className="mt-4 grid grid-cols-3 gap-3 pt-3 border-t border-line text-xs">
                    <div>
                      <div className="text-muted">Deadline</div>
                      <div className="font-mono-data text-ink mt-0.5">
                        {project.deadline ? formatDateDDMMYYYY(project.deadline) : 'Flexible'}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted">Plate Cap</div>
                      <div className="font-mono-data text-ink mt-0.5">
                        {project.plateCapacity} pcs
                      </div>
                    </div>
                    <div>
                      <div className="text-muted">Reserved Stock</div>
                      <div className="font-mono-data text-ink mt-0.5">
                        {allocatedPcs.toLocaleString()} pcs
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 text-xs text-muted">
                    Colors:{' '}
                    {project.assignedColorIds
                      .map((cid) => workspace.colors.find((c) => c.id === cid)?.name)
                      .filter(Boolean)
                      .join(', ') || 'None'}
                    {progress.printingPlates > 0 && (
                      <span className="text-brand-text font-medium">
                        {` · ${progress.printingPlates} currently printing`}
                      </span>
                    )}
                  </div>

                  {project.notes && (
                    <p className="mt-2 text-xs text-ink-secondary line-clamp-2">
                      {project.notes}
                    </p>
                  )}
                </div>

                <div className="mt-5 pt-4 border-t border-line flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        onSelectProject(project.id);
                        onNavigate('planner');
                      }}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-brand hover:bg-brand-hover text-white transition-colors whitespace-nowrap"
                    >
                      Plan Plates
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onSelectProject(project.id);
                        onNavigate('queue');
                      }}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg border border-line bg-surface hover:bg-elevated text-ink-secondary hover:text-ink transition-colors whitespace-nowrap"
                    >
                      View Queue
                    </button>
                    <button
                      type="button"
                      onClick={() => openEditProjectForm(project)}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg border border-line bg-surface hover:bg-elevated text-ink-secondary hover:text-ink transition-colors whitespace-nowrap"
                    >
                      Edit
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    {project.status !== 'Archived' ? (
                      <button
                        type="button"
                        onClick={() => onUpdateProjectStatus(project.id, 'Archived')}
                        className="text-xs text-muted hover:text-error-text transition-colors whitespace-nowrap"
                      >
                        Archive
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onUpdateProjectStatus(project.id, 'Active')}
                        className="text-xs font-semibold text-brand-text hover:underline whitespace-nowrap"
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
