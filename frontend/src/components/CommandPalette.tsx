import React, { useState, useEffect } from 'react';

export interface CommandAction {
  id: string;
  title: string;
  shortcut?: string;
  category: 'loan' | 'navigation' | 'settings';
  handler: () => void;
}

export interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  actions: CommandAction[];
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({ isOpen, onClose, actions }) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const filteredActions = actions.filter(action =>
    action.title.toLowerCase().includes(query.toLowerCase())
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (isOpen) onClose();
      } else if (e.key === 'Escape' && isOpen) {
        onClose();
      } else if (e.key === 'ArrowDown' && isOpen) {
        e.preventDefault();
        setSelectedIndex(prev => (prev + 1) % (filteredActions.length || 1));
      } else if (e.key === 'ArrowUp' && isOpen) {
        e.preventDefault();
        setSelectedIndex(prev => (prev - 1 + (filteredActions.length || 1)) % (filteredActions.length || 1));
      } else if (e.key === 'Enter' && isOpen && filteredActions[selectedIndex]) {
        e.preventDefault();
        filteredActions[selectedIndex].handler();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, filteredActions, selectedIndex, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/50" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg bg-white rounded-lg shadow-2xl overflow-hidden border border-gray-200">
        <div className="p-3 border-b border-gray-100 flex items-center">
          <input
            type="text"
            className="w-full px-3 py-2 text-sm outline-none placeholder-gray-400"
            placeholder="Type a command or search loans (Ctrl+K)..."
            value={query}
            onChange={e => { setQuery(e.target.value); setSelectedIndex(0); }}
            autoFocus
          />
        </div>
        <div className="max-h-60 overflow-y-auto divide-y divide-gray-50">
          {filteredActions.length === 0 ? (
            <div className="p-4 text-center text-sm text-gray-500">No matching commands found.</div>
          ) : (
            filteredActions.map((action, index) => (
              <div
                key={action.id}
                className={`flex items-center justify-between px-4 py-2 text-sm cursor-pointer ${
                  index === selectedIndex ? 'bg-blue-50 text-blue-900 font-medium' : 'text-gray-700 hover:bg-gray-50'
                }`}
                onClick={() => { action.handler(); onClose(); }}
              >
                <span>{action.title}</span>
                {action.shortcut && (
                  <span className="text-xs bg-gray-100 px-1.5 py-0.5 rounded text-gray-500">{action.shortcut}</span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
