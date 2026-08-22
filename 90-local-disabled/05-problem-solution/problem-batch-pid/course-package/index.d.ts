import { Context, Filter, ObjectId } from 'hydrooj';
export declare const TYPE_COURSE_PACKAGE: 10880;
export declare const TYPE_COURSE_PACKAGE_VERSION: 10881;
export interface CoursePackageLesson {
    id: string;
    title: string;
    content: string;
    pids: number[];
    tags: string[];
}
export interface CoursePackageChapter {
    id: string;
    title: string;
    content: string;
    lessons: CoursePackageLesson[];
}
export interface CoursePackageDoc {
    _id: ObjectId;
    docType: 10880;
    docId: ObjectId;
    domainId: string;
    owner: number;
    title: string;
    content: string;
    pin?: number;
    hidden?: boolean;
    tags?: string[];
    nVersion?: number;
    updateAt?: Date;
}
export interface CoursePackageVersionDoc {
    _id: ObjectId;
    docType: 10881;
    docId: ObjectId;
    parentType: 10880;
    parentId: ObjectId;
    domainId: string;
    owner: number;
    title: string;
    content: string;
    version: string;
    treeText: string;
    chapters: CoursePackageChapter[];
    stages?: any[];
    pin?: number;
    updateAt?: Date;
}
declare module 'hydrooj' {
    interface Model {
        coursePackage: typeof CoursePackageModel;
    }
    interface DocType {
        [TYPE_COURSE_PACKAGE]: CoursePackageDoc;
        [TYPE_COURSE_PACKAGE_VERSION]: CoursePackageVersionDoc;
    }
}
export declare class CoursePackageModel {
    static add(domainId: string, owner: number, title: string, content: string, pin?: number, tags?: string[]): Promise<ObjectId>;
    static get(domainId: string, cpid: ObjectId): Promise<CoursePackageDoc | null>;
    static getMulti(domainId: string, query?: Filter<CoursePackageDoc>): any;
    static edit(domainId: string, cpid: ObjectId, $set: Partial<CoursePackageDoc>): Promise<CoursePackageDoc>;
    static del(domainId: string, cpid: ObjectId): Promise<any>;
    static addVersion(domainId: string, cpid: ObjectId, owner: number, title: string, version: string, content: string, treeText: string, pin?: number): Promise<ObjectId>;
    static getVersion(domainId: string, vid: ObjectId): Promise<CoursePackageVersionDoc | null>;
    static getMultiVersion(domainId: string, cpid: ObjectId): any;
    static editVersion(domainId: string, vid: ObjectId, $set: Partial<CoursePackageVersionDoc>): Promise<CoursePackageVersionDoc>;
    static setVersionChapters(domainId: string, vid: ObjectId, chapters: CoursePackageChapter[]): Promise<CoursePackageVersionDoc>;
    static delVersion(domainId: string, cpid: ObjectId, vid: ObjectId): Promise<void>;
}
export declare function apply(ctx: Context): Promise<void>;
