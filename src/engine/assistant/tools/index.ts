/**
 * Importing this module registers the built-in tools. Same shape as the component and modifier
 * registries: a new tool is a new file plus a line here, and the MCP server, the tool-use loop
 * and the editor's transcript all pick it up with no changes of their own.
 */
import './describe';
import './create';
import './edit';
import './components';
import './modifiers';
import './scatter';

export * from './shared';
