import React, { useState, useCallback } from 'react';
import { Search, Layers, FileText, Package, AlertCircle, Folder, File, ChevronRight, ChevronDown } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const FileTree = ({ files, onFileClick }) => {
  const [expandedFolders, setExpandedFolders] = useState(new Set());

  const toggleFolder = (path) => {
    const newExpanded = new Set(expandedFolders);
    if (newExpanded.has(path)) {
      newExpanded.delete(path);
    } else {
      newExpanded.add(path);
    }
    setExpandedFolders(newExpanded);
  };

  const renderTreeNode = (node, path = '') => {
    const fullPath = path ? `${path}/${node.name}` : node.name;
    
    if (node.type === 'directory') {
      const isExpanded = expandedFolders.has(fullPath);
      return (
        <div key={fullPath} className="ml-4">
          <div 
            className="flex items-center gap-2 p-1 hover:bg-gray-100 rounded cursor-pointer"
            onClick={() => toggleFolder(fullPath)}
          >
            {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <Folder size={16} className="text-blue-500" />
            <span>{node.name}</span>
            <span className="text-gray-400 text-sm ml-2">{node.size}</span>
          </div>
          {isExpanded && node.children && (
            <div className="ml-4">
              {node.children.map(child => renderTreeNode(child, fullPath))}
            </div>
          )}
        </div>
      );
    } else {
      return (
        <div 
          key={fullPath}
          className="flex items-center gap-2 p-1 hover:bg-gray-100 rounded cursor-pointer ml-8"
          onClick={() => onFileClick({ ...node, path: fullPath })}
        >
          <File size={16} className="text-gray-500" />
          <span>{node.name}</span>
          <span className="text-gray-400 text-sm ml-2">{node.size}</span>
        </div>
      );
    }
  };

  return <div className="mt-2">{files.map(file => renderTreeNode(file))}</div>;
};

const FileViewer = ({ file }) => {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  React.useEffect(() => {
    const fetchFileContent = async () => {
      try {
        setLoading(true);
        const response = await fetch(
          `${API_URL}/api/file/${encodeURIComponent(file.path)}`
        );
        if (!response.ok) throw new Error('Failed to fetch file content');
        const data = await response.json();
        setContent(data.content);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    if (file) {
      fetchFileContent();
    }
  }, [file]);

  if (loading) return <div className="p-4">Loading file content...</div>;
  if (error) return <div className="p-4 text-red-500">Error: {error}</div>;

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText size={18} />
          {file.name}
          <span className="text-sm text-gray-500 ml-2">{file.size}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <pre className="p-4 rounded bg-gray-50 overflow-x-auto">
          <code>{content}</code>
        </pre>
      </CardContent>
    </Card>
  );
};

const DockerInspector = () => {
  const [imageUrl, setImageUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('files');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [inspectionData, setInspectionData] = useState(null);
  const [jobId, setJobId] = useState(null);

  const pollJobStatus = useCallback(async (jobId) => {
    try {
      const response = await fetch(`${API_URL}/api/status/${jobId}`);
      const data = await response.json();
      
      if (data.status === 'completed') {
        const resultsResponse = await fetch(`${API_URL}/api/results/${jobId}`);
        const results = await resultsResponse.json();
        setInspectionData(results);
        setLoading(false);
      } else if (data.status === 'failed') {
        setError(data.error);
        setLoading(false);
      } else {
        // Continue polling
        setTimeout(() => pollJobStatus(jobId), 1000);
      }
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }, []);

  const handleInspect = async () => {
    try {
      setLoading(true);
      setError(null);
      setInspectionData(null);
      
      const response = await fetch(`${API_URL}/api/inspect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ image_name: imageUrl }),
      });
      
      if (!response.ok) {
        throw new Error('Failed to start inspection');
      }
      
      const { job_id } = await response.json();
      setJobId(job_id);
      pollJobStatus(job_id);
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  };

  const handleFileClick = async (file) => {
    setSelectedFile(file);
  };

  const filteredFiles = React.useMemo(() => {
    if (!inspectionData?.files || !searchTerm) return inspectionData?.files || [];
    
    const searchLower = searchTerm.toLowerCase();
    const filterNodes = (nodes) => {
      return nodes.filter(node => {
        const matches = node.name.toLowerCase().includes(searchLower);
        if (node.children) {
          node.children = filterNodes(node.children);
          return matches || node.children.length > 0;
        }
        return matches;
      });
    };
    
    return filterNodes([...inspectionData.files]);
  }, [inspectionData?.files, searchTerm]);

  return (
    <div className="max-w-6xl mx-auto p-4">
      {/* Search Bar */}
      <div className="mb-6">
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Enter Docker image (e.g., nginx:latest)"
            className="flex-1 p-2 border rounded"
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
          />
          <button 
            className="bg-blue-600 text-white px-4 py-2 rounded flex items-center gap-2 disabled:bg-blue-300"
            onClick={handleInspect}
            disabled={loading || !imageUrl}
          >
            <Search size={18} />
            {loading ? 'Inspecting...' : 'Inspect'}
          </button>
        </div>
      </div>

      {error && (
        <Alert className="mb-4 bg-red-50">
          <AlertCircle className="h-4 w-4 text-red-500" />
          <AlertDescription className="text-red-500">
            Error: {error}
          </AlertDescription>
        </Alert>
      )}

      {/* Content Tabs */}
      {inspectionData && (
        <div className="mb-4">
          <div className="flex gap-4 border-b">
            <button
              className={`p-2 ${activeTab === 'files' ? 'border-b-2 border-blue-600' : ''}`}
              onClick={() => setActiveTab('files')}
            >
              <span className="flex items-center gap-2">
                <FileText size={18} /> Files
              </span>
            </button>
            <button
              className={`p-2 ${activeTab === 'layers' ? 'border-b-2 border-blue-600' : ''}`}
              onClick={() => setActiveTab('layers')}
            >
              <span className="flex items-center gap-2">
                <Layers size={18} /> Layers
              </span>
            </button>
            <button
              className={`p-2 ${activeTab === 'metadata' ? 'border-b-2 border-blue-600' : ''}`}
              onClick={() => setActiveTab('metadata')}
            >
              <span className="flex items-center gap-2">
                <Package size={18} /> Metadata
              </span>
            </button>
          </div>
        </div>
      )}

      {/* Alert for Privacy Notice */}
      <Alert className="mb-4">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          Your image inspection data is encrypted and automatically deleted after 24 hours.
        </AlertDescription>
      </Alert>

      {/* Loading State */}
      {loading && (
        <div className="text-center py-8">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Inspecting Docker image...</p>
        </div>
      )}

      {/* Content Area */}
      {inspectionData && (
        <div className="grid gap-4">
          {activeTab === 'files' && (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>File Browser</CardTitle>
                  <input
                    type="text"
                    placeholder="Search files..."
                    className="w-full p-2 border rounded"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                </CardHeader>
                <CardContent>
                  <FileTree files={filteredFiles} onFileClick={handleFileClick} />
                </CardContent>
              </Card>
              {selectedFile && <FileViewer file={selectedFile} />}
            </>
          )}

          {activeTab === 'layers' && (
            <Card>
              <CardHeader>
                <CardTitle>Layer Analysis</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {inspectionData.inspection.layers.map((layer, index) => (
                    <div key={index} className="border-b pb-4">
                      <div className="flex justify-between mb-2">
                        <span className="font-mono text-sm">{layer.digest.substring(0, 12)}...</span>
                        <span className="text-gray-500">{layer.size}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === 'metadata' && (
            <Card>
              <CardHeader>
                <CardTitle>Image Metadata</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {Object.entries(inspectionData.inspection.config).map(([key, value]) => (
                    <div key={key} className="flex justify-between p-2 border-b">
                      <span className="font-medium">{key}</span>
                      <span className="text-gray-600">
                        {typeof value === 'object' ? JSON.stringify(value) : value}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
};

export default DockerInspector;
